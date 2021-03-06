const ora2 = require('ora')
const { gray } = require('chalk')
const eraseLines = require('./erase-lines')

const wait = (msg, timeOut = 300, ora = ora2) => {
  let running = false
  let spinner
  let stopped = false

  setTimeout(() => {
    if (stopped) return
    
    spinner = ora(gray(msg))
    spinner.color = 'gray'
    spinner.start()
    
    running = true
  }, timeOut)

  return () => {
    stopped = true
    
    if (running) {
      spinner.stop()
      process.stdout.write(eraseLines(1))
      running = false
    }
  }
}

module.exports = wait
