#!/usr/bin/env node
//@flow

// Native
const { resolve, basename } = require('path')

// Packages
const Progress = require('progress')
const fs = require('fs-extra')
const bytes = require('bytes')
const chalk = require('chalk')
const mri = require('mri')
const ms = require('ms')
const dotenv = require('dotenv')
const { eraseLines } = require('ansi-escapes')
const { write: copy } = require('clipboardy')
const inquirer = require('inquirer')
const retry = require('async-retry')
const jsonlines = require('jsonlines')

// Utilities
const Logger = require('../util/build-logger')
const Now = require('../util')
const createOutput = require('../../../util/output')
const toHumanPath = require('../../../util/humanize-path')
const { handleError, error } = require('../util/error')
const { fromGit, isRepoPath, gitPathParts } = require('../util/git')
const readMetaData = require('../util/read-metadata')
const checkPath = require('../util/check-path')
const logo = require('../../../util/output/logo')
const cmd = require('../../../util/output/cmd')
const wait = require('../../../util/output/wait')
const promptBool = require('../../../util/input/prompt-bool')
const promptOptions = require('../util/prompt-options')
const note = require('../../../util/output/note')
const exit = require('../../../util/exit')

const REGIONS = new Set(["sfo", "bru"]);
const DCS = new Set(["sfo1", "bru1"]);

const mriOpts = {
  string: ['name', 'alias', 'session-affinity', 'regions'],
  boolean: [
    'help',
    'version',
    'debug',
    'force',
    'links',
    'no-clipboard',
    'forward-npm',
    'docker',
    'npm',
    'static',
    'public'
  ],
  alias: {
    env: 'e',
    dotenv: 'E',
    help: 'h',
    debug: 'd',
    version: 'v',
    force: 'f',
    links: 'l',
    public: 'p',
    'no-clipboard': 'C',
    'forward-npm': 'N',
    'session-affinity': 'S',
    name: 'n',
    alias: 'a'
  }
}

const help = () => {
  console.log(`
  ${chalk.bold(`${logo} now`)} [options] <command | path>

  ${chalk.dim('Commands:')}

    ${chalk.dim('Cloud')}

      deploy               [path]      Performs a deployment ${chalk.bold(
        '(default)'
      )}
      ls | list            [app]       List deployments
      rm | remove          [id]        Remove a deployment
      ln | alias           [id] [url]  Configures aliases for deployments
      domains              [name]      Manages your domain names
      certs                [cmd]       Manages your SSL certificates
      secrets              [name]      Manages your secret environment variables
      dns                  [name]      Manages your DNS records
      logs                 [url]       Displays the logs for a deployment
      scale                [args]      Scales the instance count of a deployment
      help                 [cmd]       Displays complete help for [cmd]

    ${chalk.dim('Administrative')}

      billing | cc         [cmd]       Manages your credit cards and billing methods
      upgrade | downgrade  [plan]      Upgrades or downgrades your plan
      teams                [team]      Manages your teams
      switch                           Switches between teams and your account
      login                            Login into your account or creates a new one
      logout                           Logout from your account

  ${chalk.dim('Options:')}

    -h, --help                     Output usage information
    -v, --version                  Output the version number
    -n, --name                     Set the name of the deployment
    -A ${chalk.bold.underline('FILE')}, --local-config=${chalk.bold.underline(
    'FILE'
  )}   Path to the local ${'`now.json`'} file
    -Q ${chalk.bold.underline('DIR')}, --global-config=${chalk.bold.underline(
    'DIR'
  )}    Path to the global ${'`.now`'} directory
    -d, --debug                    Debug mode [off]
    -f, --force                    Force a new deployment even if nothing has changed
    -t ${chalk.underline('TOKEN')}, --token=${chalk.underline(
    'TOKEN'
  )}        Login token
    -l, --links                    Copy symlinks without resolving their target
    -p, --public                   Deployment is public (${chalk.dim(
      '`/_src`'
    )} is exposed) [on for oss, off for premium]
    -e, --env                      Include an env var (e.g.: ${chalk.dim(
      '`-e KEY=value`'
    )}). Can appear many times.
    -E ${chalk.underline('FILE')}, --dotenv=${chalk.underline(
    'FILE'
  )}         Include env vars from .env file. Defaults to '.env'
    -C, --no-clipboard             Do not attempt to copy URL to clipboard
    -N, --forward-npm              Forward login information to install private npm modules
    --session-affinity             Session affinity, \`ip\` or \`random\` (default) to control session affinity
    -T, --team                     Set a custom team scope
    --regions                      Set default regions or DCs to enable the deployment on

  ${chalk.dim(`Enforceable Types (by default, it's detected automatically):`)}

    --npm                          Node.js application
    --docker                       Docker container
    --static                       Static file hosting

  ${chalk.dim('Examples:')}

  ${chalk.gray('–')} Deploy the current directory

    ${chalk.cyan('$ now')}

  ${chalk.gray('–')} Deploy a custom path

    ${chalk.cyan('$ now /usr/src/project')}

  ${chalk.gray('–')} Deploy a GitHub repository

    ${chalk.cyan('$ now user/repo#ref')}

  ${chalk.gray('–')} Deploy with environment variables

    ${chalk.cyan('$ now -e NODE_ENV=production -e SECRET=@mysql-secret')}

  ${chalk.gray('–')} Show the usage information for the sub command ${chalk.dim(
    '`list`'
  )}

    ${chalk.cyan('$ now help list')}
`)
}

let argv
let paths

// Options
let forceNew
let deploymentName
let sessionAffinity
let log
let debug
let debugEnabled
let clipboard
let forwardNpm
let followSymlinks
let wantsPublic
let regions
let apiUrl
let isTTY
let quiet
let alwaysForwardNpm
let meta

// If the current deployment is a repo
const gitRepo = {}

const stopDeployment = async msg => {
  handleError(msg)
  await exit(1)
}

// Converts `env` Arrays, Strings and Objects into env Objects.
// `null` empty value means to prompt user for value upon deployment.
// `undefined` empty value means to inherit value from user's env.
const parseEnv = (env, empty) => {
  if (!env) {
    return {}
  }
  if (typeof env === 'string') {
    // a single `--env` arg comes in as a String
    env = [env]
  }
  if (Array.isArray(env)) {
    return env.reduce((o, e) => {
      let key
      let value
      const equalsSign = e.indexOf('=')
      if (equalsSign === -1) {
        key = e
        value = empty
      } else {
        key = e.substr(0, equalsSign)
        value = e.substr(equalsSign + 1)
      }
      o[key] = value
      return o
    }, {})
  }
  // assume it's already an Object
  return env
}

const promptForEnvFields = async list => {
  if (list.length === 0) {
    return {}
  }

  const questions = []

  for (const field of list) {
    questions.push({
      name: field,
      message: field
    })
  }

  // eslint-disable-next-line import/no-unassigned-import
  require('../../../util/input/patch-inquirer')

  log('Please enter values for the following environment variables:')
  const answers = await inquirer.prompt(questions)

  for (const answer of Object.keys(answers)) {
    const content = answers[answer]

    if (content === '') {
      await stopDeployment(`Enter a value for ${answer}`)
    }
  }

  return answers
}

async function main(ctx: any) {
  argv = mri(ctx.argv.slice(2), mriOpts)

  // very ugly hack – this (now-cli's code) expects that `argv._[0]` is the path
  // we should fix this ASAP
  if (argv._[0] === 'sh') {
    argv._.shift()
  }

  if (argv._[0] === 'deploy') {
    argv._.shift()
  }

  if (argv._.length > 0) {
    // If path is relative: resolve
    // if path is absolute: clear up strange `/` etc
    paths = argv._.map(item => resolve(process.cwd(), item))
  } else {
    paths = [process.cwd()]
  }

  // Options
  forceNew = argv.force
  deploymentName = argv.name
  sessionAffinity = argv['session-affinity']
  debugEnabled = argv.debug
  clipboard = !argv['no-clipboard']
  forwardNpm = argv['forward-npm']
  followSymlinks = !argv.links
  wantsPublic = argv.public
  regions = (argv.regions || '').split(',').map(s => s.trim()).filter(Boolean)
  apiUrl = ctx.apiUrl
  // https://github.com/facebook/flow/issues/1825
  // $FlowFixMe
  isTTY = process.stdout.isTTY
  quiet = !isTTY
  ;({ log, debug } = createOutput({ debug: debugEnabled }))

  if (argv.h || argv.help) {
    help()
    await exit(0)
  }

  const { authConfig: { credentials }, config: { sh } } = ctx
  const { token } = credentials.find(item => item.provider === 'sh')
  const config = sh

  alwaysForwardNpm = config.forwardNpm

  try {
    return sync({ token, config, showMessage: true })
  } catch (err) {
    await stopDeployment(err)
  }
}

async function sync({ token, config: { currentTeam, user }, showMessage }) {
  return new Promise(async (_resolve, reject) => {
    const start = Date.now()
    const rawPath = argv._[0]

    let deployment
    let deploymentType
    let isFile

    if (paths.length === 1) {
      try {
        const fsData = await fs.lstat(paths[0])

        if (fsData.isFile()) {
          isFile = true
          deploymentType = 'static'
        }
      } catch (err) {
        let repo
        let isValidRepo = false

        try {
          isValidRepo = isRepoPath(rawPath)
        } catch (_err) {
          if (err.code === 'INVALID_URL') {
            await stopDeployment(_err)
          } else {
            reject(_err)
          }
        }

        if (isValidRepo) {
          const gitParts = gitPathParts(rawPath)
          Object.assign(gitRepo, gitParts)

          const searchMessage = setTimeout(() => {
            log(`Didn't find directory. Searching on ${gitRepo.type}...`)
          }, 500)

          try {
            repo = await fromGit(rawPath, debugEnabled)
          } catch (err) {}

          clearTimeout(searchMessage)
        }

        if (repo) {
          // Tell now which directory to deploy
          paths = [ repo.path ]

          // Set global variable for deleting tmp dir later
          // once the deployment has finished
          Object.assign(gitRepo, repo)
        } else if (isValidRepo) {
          const gitRef = gitRepo.ref ? `with "${chalk.bold(gitRepo.ref)}" ` : ''

          await stopDeployment(`There's no repository named "${chalk.bold(
              gitRepo.main
            )}" ${gitRef}on ${gitRepo.type}`)
        } else {
          log(error(`The specified directory "${basename(paths[0])}" doesn't exist.`))
          await exit(1)
        }
      }
    } else {
      isFile = false
      deploymentType = 'static'
    }

    const checkers = []

    if (isFile || (!isFile && paths.length === 1)) {
      checkers.push(checkPath(paths[0]))
    } else {
      for (const path of paths) {
        const fsData = await fs.lstat(path)

        if (fsData.isFile()) {
          continue
        }

        checkers.push(checkPath(path))
      }
    }

    try {
      await Promise.all(checkers)
    } catch (err) {
      log(error({
        message: err.message,
        slug: 'path-not-deployable'
      }))

      await exit(1)
    }

    if (!quiet && showMessage) {
      if (gitRepo.main) {
        const gitRef = gitRepo.ref ? ` at "${chalk.bold(gitRepo.ref)}" ` : ''

        log(`Deploying ${gitRepo.type} repository "${chalk.bold(
            gitRepo.main
          )}"${gitRef} under ${chalk.bold(
            (currentTeam && currentTeam.slug) || user.username || user.email
          )}`)
      } else {
        const list = paths
          .map((path, index) => {
            let suffix = ''

            if (paths.length > 1 && index !== paths.length - 1) {
              suffix = index < paths.length - 2 ? ', ' : ' and '
            }

            return chalk.bold(toHumanPath(path)) + suffix
          })
          .join('')

        log(`Deploying ${list} under ${chalk.bold(
            (currentTeam && currentTeam.slug) || user.username || user.email
          )}`)
      }
    }

    if (!isFile && deploymentType !== 'static') {
      if (argv.docker) {
        debug(`Forcing \`deploymentType\` = \`docker\``)
        deploymentType = 'docker'
      } else if (argv.npm) {
        debug(`Forcing \`deploymentType\` = \`npm\``)
        deploymentType = 'npm'
      } else if (argv.static) {
        debug(`Forcing \`deploymentType\` = \`static\``)
        deploymentType = 'static'
      }
    } else if (deploymentType === 'static') {
      debug(`Forcing \`deploymentType\` = \`static\` automatically`)

      meta = {
        name: deploymentName || (isFile
          ? 'file'
          : paths.length === 1 ? basename(paths[0]) : 'files'),
        type: deploymentType,
        pkg: undefined,
        nowConfig: undefined,
        hasNowJson: false,

        // XXX: legacy
        deploymentType,
        sessionAffinity
      }
    }

    if (!meta) {
      ;({
        meta,
        deploymentName,
        deploymentType,
        sessionAffinity
      } = await readMeta(paths[0], deploymentName, deploymentType, sessionAffinity))
    }

    const nowConfig = meta.nowConfig

    let scale
    if (regions.length) {
      // ignore now.json if regions cli option exists
      scale = {}
    } else {
      const _nowConfig = nowConfig || {}
      regions = _nowConfig.regions || []
      scale = _nowConfig.scale || {}
    }

    // get all the region or dc identifiers from the scale settings
    const scaleKeys = Object.keys(scale);

    for (const scaleKey of scaleKeys) {
      if (!isValidRegionOrDcId(scaleKey)) {
        log(error({
          message: `The value "${scaleKey}" in \`scale\` settings is not a valid region or DC identifier`,
          slug: 'invalid-region-or-dc'
        }))
        await exit(1)
      }
    }

    if (regions.length) {
      if (Object.keys(scale).length) {
        log(error({
          message: "Can't set both `regions` and `scale` options simultaneously",
          slug: 'regions-and-scale-at-once'
        }))
        await exit(1)
      }

      for (const r of regions) {
        if (!isValidRegionOrDcId(r)) {
          log(error({
            message: `The value "${r}" in \`--regions\` is not a valid region or DC identifier`,
            slug: 'invalid-region-or-dc'
          }))
          await exit(1)
        }

        scale[getDcId(r)] = { min: 0, max: 1 }
      }
    }

    const now = new Now({ apiUrl, token, debug: debugEnabled, currentTeam })

    let dotenvConfig
    let dotenvOption

    if (argv.dotenv) {
      dotenvOption = argv.dotenv
    } else if (nowConfig && nowConfig.dotenv) {
      dotenvOption = nowConfig.dotenv
    }

    if (dotenvOption) {
      const dotenvFileName =
        typeof dotenvOption === 'string' ? dotenvOption : '.env'

      try {
        const dotenvFile = await fs.readFile(dotenvFileName)
        dotenvConfig = dotenv.parse(dotenvFile)
      } catch (err) {
        if (err.code === 'ENOENT') {
          log(error({
            message: `--dotenv flag is set but ${dotenvFileName} file is missing`,
            slug: 'missing-dotenv-target'
          }))

          await exit(1)
        } else {
          throw err
        }
      }
    }

    // Merge dotenv config, `env` from now.json, and `--env` / `-e` arguments
    const deploymentEnv = Object.assign(
      {},
      dotenvConfig,
      parseEnv(nowConfig && nowConfig.env, null),
      parseEnv(argv.env, undefined)
    )

    // If there's any envs with `null` then prompt the user for the values
    const askFor = Object.keys(deploymentEnv).filter(
      key => deploymentEnv[key] === null
    )
    Object.assign(deploymentEnv, await promptForEnvFields(askFor))

    let secrets
    const findSecret = async uidOrName => {
      if (!secrets) {
        secrets = await now.listSecrets()
      }

      return secrets.filter(secret => {
        return secret.name === uidOrName || secret.uid === uidOrName
      })
    }

    const env_ = await Promise.all(
      Object.keys(deploymentEnv).map(async key => {
        if (!key) {
          log(error({
            message: 'Environment variable name is missing',
            slug: 'missing-env-key-value'
          }))

          await exit(1)
        }

        if (/[^A-z0-9_]/i.test(key)) {
          log(error(
            `Invalid ${chalk.dim('-e')} key ${chalk.bold(
              `"${chalk.bold(key)}"`
            )}. Only letters, digits and underscores are allowed.`
          ))

          await exit(1)
        }

        let val = deploymentEnv[key]

        if (val === undefined) {
          if (key in process.env) {
            log(
              `Reading ${chalk.bold(
                `"${chalk.bold(key)}"`
              )} from your env (as no value was specified)`
            )
            // Escape value if it begins with @
            if (process.env[key] != null) {
              val = process.env[key].replace(/^@/, '\\@')
            }
          } else {
            log(error(
              `No value specified for env ${chalk.bold(
                `"${chalk.bold(key)}"`
              )} and it was not found in your env.`
            ))

            await exit(1)
          }
        }

        if (val[0] === '@') {
          const uidOrName = val.substr(1)
          const _secrets = await findSecret(uidOrName)

          if (_secrets.length === 0) {
            if (uidOrName === '') {
              log(error(
                `Empty reference provided for env key ${chalk.bold(
                  `"${chalk.bold(key)}"`
                )}`
              ))
            } else {
              log(error({
                message: `No secret found by uid or name ${chalk.bold(`"${uidOrName}"`)}`,
                slug: 'env-no-secret'
              }))
            }

            await exit(1)
          } else if (_secrets.length > 1) {
            log(error(
              `Ambiguous secret ${chalk.bold(
                `"${uidOrName}"`
              )} (matches ${chalk.bold(_secrets.length)} secrets)`
            ))

            await exit(1)
          }

          val = { uid: _secrets[0].uid }
        }

        return [key, typeof val === 'string' ? val.replace(/^\\@/, '@') : val]
      })
    )

    const env = {}

    env_.filter(v => Boolean(v)).forEach(([key, val]) => {
      if (key in env) {
        log(
          note(`Overriding duplicate env key ${chalk.bold(`"${key}"`)}`)
        )
      }

      env[key] = val
    })

    let syncCount

    try {
      // $FlowFixMe
      const createArgs = Object.assign(
        {
          env,
          followSymlinks,
          forceNew,
          forwardNpm: alwaysForwardNpm || forwardNpm,
          quiet,
          scale,
          wantsPublic,
          sessionAffinity,
          isFile
        },
        meta
      )

      deployment = await now.create(paths, createArgs)

      if (now.syncFileCount > 0) {
        await new Promise((resolve) => {
          if (now.syncFileCount !== now.fileCount) {
            debug(`Total files ${now.fileCount}, ${now.syncFileCount} changed`)
          }

          const size = bytes(now.syncAmount)
          syncCount = `${now.syncFileCount} file${now.syncFileCount > 1
            ? 's'
            : ''}`
          const bar = new Progress(
            `> Upload [:bar] :percent :etas (${size}) [${syncCount}]`,
            {
              width: 20,
              complete: '=',
              incomplete: '',
              total: now.syncAmount,
              clear: true
            }
          )

          now.upload()

          now.on('upload', ({ names, data }) => {
            const amount = data.length
            debug(`Uploaded: ${names.join(' ')} (${bytes(data.length)})`)

            bar.tick(amount)
          })

          now.on('complete', () => resolve())

          now.on('error', err => {
            log(error('Upload failed'))
            reject(err)
          })
        })

        deployment = await now.create(paths, createArgs)
      }
    } catch (err) {
      if (err.code === 'plan_requires_public') {
        if (!wantsPublic) {
          const who = currentTeam ? 'your team is' : 'you are'

          let proceed
          log(`Your deployment's code and logs will be publicly accessible because ${who} subscribed to the OSS plan.`)

          if (isTTY) {
            proceed = await promptBool('Are you sure you want to proceed?', {
              trailing: eraseLines(1)
            })
          }

          let url = 'https://zeit.co/account/plan'

          if (currentTeam) {
            url = `https://zeit.co/teams/${currentTeam.slug}/settings/plan`
          }

          log(note(`You can use ${cmd('now --public')} or upgrade your plan (${url}) to skip this prompt`))

          if (!proceed) {
            if (typeof proceed === 'undefined') {
              const message = `If you agree with that, please run again with ${cmd('--public')}.`
              log(error(message))

              await exit(1)
            } else {
              log('Aborted')
              await exit(0)
            }

            return
          }
        }

        wantsPublic = true

        sync({
          token,
          config: {
            currentTeam,
            user
          },
          showMessage: false
        })

        return
      }

      debug(`Error: ${err}\n${err.stack}`)

      if (err.keyword === 'additionalProperties' && err.dataPath === '.scale') {
        const { additionalProperty = '' } = err.params || {}
        const message = regions.length
          ? `Invalid regions: ${additionalProperty.slice(0, -1)}`
          : `Invalid DC name for the scale option: ${additionalProperty}`
        log(error(message));
        await exit(1)
      }

      await stopDeployment(err)
    }

    const { url } = now
    const elapsed = ms(new Date() - start)

    if (isTTY) {
      if (clipboard) {
        try {
          await copy(url)

          log(
            chalk`{cyan Ready!} {bold ${url}} (copied to clipboard) [${elapsed}]`
          )
        } catch (err) {
          debug(`Error copying to clipboard: ${err}`)
          log(chalk`{cyan Ready!} {bold ${url}} [${elapsed}]`)
        }
      } else {
        log(`${url} [${elapsed}]`)
      }
    } else {
      process.stdout.write(url)
    }

    if (!quiet) {
      if (syncCount) {
        log(`Synced ${syncCount} (${bytes(now.syncAmount)}) [${elapsed}]`)
      }
    }

    // Show build logs
    if (deploymentType === 'static') {
      if (!quiet) {
        log(chalk`{cyan Deployment complete!}`)
      }
      await exit(0)
    } else {
      if (nowConfig && nowConfig.atlas) {
        const cancelWait = wait('Initializing...')

        try {
          await printEvents(now, currentTeam, { onOpen: cancelWait })
        } catch (err) {
          cancelWait()
          throw err
        }

        await exit(0)
      } else {
        if (!quiet) {
          log('Initializing…')
        }

        printLogs(deployment, token)
      }
    }
  })
}

async function readMeta(
  _path,
  _deploymentName,
  deploymentType,
  _sessionAffinity
) {
  try {
    const meta = await readMetaData(_path, {
      deploymentType,
      deploymentName: _deploymentName,
      quiet: true,
      sessionAffinity: _sessionAffinity
    })

    if (!deploymentType) {
      deploymentType = meta.type
      debug(`Detected \`deploymentType\` = \`${deploymentType}\``)
    }

    if (!_deploymentName) {
      _deploymentName = meta.name
      debug(`Detected \`deploymentName\` = "${_deploymentName}"`)
    }

    return {
      meta,
      deploymentName: _deploymentName,
      deploymentType,
      sessionAffinity: _sessionAffinity
    }
  } catch (err) {
    if (isTTY && err.code === 'MULTIPLE_MANIFESTS') {
      debug('Multiple manifests found, disambiguating')
      log(
        `Two manifests found. Press [${chalk.bold(
          'n'
        )}] to deploy or re-run with --flag`
      )

      deploymentType = await promptOptions([
        ['npm', `${chalk.bold('package.json')}\t${chalk.gray('   --npm')} `],
        ['docker', `${chalk.bold('Dockerfile')}\t${chalk.gray('--docker')} `]
      ])

      debug(`Selected \`deploymentType\` = "${deploymentType}"`)
      return readMeta(_path, _deploymentName, deploymentType)
    }
    throw err
  }
}

async function printEvents(now, currentTeam = null, { onOpen = ()=>{} } = {}) {
  let url = `${apiUrl}/v1/now/deployments/${now.id}/events?follow=1`

  if (currentTeam) {
    url += `&teamId=${currentTeam.id}`
  }

  debug(`Events ${url}`)

  // we keep track of how much we log in case we
  // drop the connection and have to start over
  let o = 0

  await retry(async (bail, attemptNumber) => {
    if (attemptNumber > 1) {
      debug('Retrying events')
    }

    // if we are retrying, we clear past logs
    if (!quiet && o) process.stdout.write(eraseLines(0))

    const res = await now._fetch(url)
    if (res.ok) {
      // fire the open callback and ensure it's only fired once
      onOpen()
      onOpen = ()=>{}

      // handle the event stream and make the promise get rejected
      // if errors occur so we can retry
      return new Promise((resolve, reject) => {
        const stream = res.body.pipe(jsonlines.parse())
        const onData = ({ type, payload }) => {
          // if we are 'quiet' because we are piping, simply
          // wait for the first instance to be started
          // and ignore everything else
          if (quiet) {
            if (type === 'instance-start') {
              resolve()
            }
            return
          }

          switch (type) {
            case 'build-start':
              o++
              log('Building…')
              break

            case 'stdout':
            case 'stderr':
              log(payload)
              break

            case 'build-complete':
              o++
              log(chalk`{cyan Success!} Build complete`)
              break

            case 'instance-start':
              o++
              log(chalk`{cyan Success!} Build complete`)

              // avoid lingering events
              stream.off('data', onData)

              // close the stream and resolve
              stream.end()
              resolve()
              break
          }
        }
        stream.on('data', onData)
        stream.on('error', err => {
          reject(new Error(`Deployment event stream error: ${err.stack}`))
        })
      })
    } else {
      const err = new Error(`Deployment events status ${res.status}`)

      if (res.status < 500) {
        bail(err)
      } else {
        throw err
      }
    }
  }, {
    retries: 4
  })
}

function printLogs({ url, scale = {} } = {}, token) {
  // Log build
  const logger = new Logger(url, token, { debug: debugEnabled, quiet })

  logger.on('error', async err => {
    if (!quiet) {
      if (err && err.type === 'BUILD_ERROR') {
        log(error(
          `The build step of your project failed. To retry, run ${cmd(
            'now --force'
          )}.`
        ))
      } else {
        log(error('Deployment failed'))
      }
    }

    if (gitRepo && gitRepo.cleanup) {
      // Delete temporary directory that contains repository
      gitRepo.cleanup()

      debug(`Removed temporary repo directory`)
    }

    await exit(1)
  })

  logger.on('close', async () => {
    if (!quiet) {
      log(chalk`{cyan Deployment complete!}`)

      const dcs = Object.keys(scale)
      if (dcs.length > 0) {
        log(`Running in ${dcs.map(dc => chalk.green(dc)).join(', ')}`)
      }
    }

    if (gitRepo && gitRepo.cleanup) {
      // Delete temporary directory that contains repository
      gitRepo.cleanup()

      debug(`Removed temporary repo directory`)
    }

    await exit()
  })
}

// if supplied with a region (eg: `sfo`) it returns
// the default dc for it (`sfo1`)
// if supplied with a dc id, it just returns it
function getDcId(r: string) {
  return /\d$/.test(r) ? r : `${r}1`
}

// determines if the supplied string is a valid
// region name or dc id
function isValidRegionOrDcId(r: string) {
  return REGIONS.has(r) || DCS.has(r);
}

module.exports = main
