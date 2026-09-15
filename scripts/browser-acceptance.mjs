const port = process.argv[2] ?? '9224'
const pages = await fetch(`http://127.0.0.1:${port}/json`).then((response) => response.json())
const page = pages.find((item) => item.type === 'page')
if (!page) throw new Error('Chrome page target not found')
const socket = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject })
let nextId = 1
const pending = new Map()
socket.onmessage = ({ data }) => {
  const message = JSON.parse(data)
  if (!message.id) return
  const handler = pending.get(message.id)
  if (!handler) return
  pending.delete(message.id)
  message.error ? handler.reject(new Error(message.error.message)) : handler.resolve(message.result)
}
const command = (method, params = {}) => new Promise((resolve, reject) => {
  const id = nextId++
  pending.set(id, { resolve, reject })
  socket.send(JSON.stringify({ id, method, params }))
})
const evaluate = async (expression) => {
  const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text)
  return result.result.value
}
await command('Runtime.enable')
await new Promise((resolve) => setTimeout(resolve, 800))
const report = await evaluate(`(async () => {
  const pause = (ms = 50) => new Promise(resolve => setTimeout(resolve, ms))
  const text = () => document.body.innerText
  const inputByLabel = (label) => [...document.querySelectorAll('label')].find(item => item.innerText.includes(label))?.querySelector('input,select')
  const setValue = async (element, value) => {
    const descriptor = Object.getOwnPropertyDescriptor(element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype, 'value')
    descriptor.set.call(element, String(value)); element.dispatchEvent(new Event('input', { bubbles:true })); element.dispatchEvent(new Event('change', { bubbles:true })); await pause()
  }
  const result = { checks: [] }
  const check = (name, ok, detail = '') => result.checks.push({ name, ok, detail })
  check('Основная страница открылась', document.title === 'Симулятор лифтов')
  check('Контакты присутствуют', Boolean(document.querySelector('a[aria-label="Написать в Telegram"]') && document.querySelector('a[aria-label="Написать в Мессенджере"]')))
  document.querySelectorAll('.top-disclosure').forEach(item => item.open = true)
  const capacity = inputByLabel('Вместимость')
  await setValue(capacity, 41)
  check('Вместимость выше максимума подсвечивается', capacity.getAttribute('aria-invalid') === 'true' && text().includes('Допустимое значение: от 1 до 40'))
  await setValue(capacity, 10)
  const employees = inputByLabel('Сотрудников всего')
  await setValue(employees, 10001)
  check('Численность выше максимума подсвечивается', employees.getAttribute('aria-invalid') === 'true' && text().includes('Допустимо от 1 до 10 000 сотрудников'))
  await setValue(employees, 4000)
  const equal = [...document.querySelectorAll('button')].find(item => item.textContent.trim() === 'Поровну')
  equal.click(); await pause(150)
  check('Равномерное распределение даёт сумму 4000', text().includes('4000 сотрудников') || text().includes('4 000 сотрудников'))
  const methodology = [...document.querySelectorAll('button')].find(item => item.textContent.trim() === 'Описание алгоритма')
  methodology.click(); await pause(100)
  check('Открывается описание алгоритма', text().includes('Как работает расчёт') && new URL(location.href).searchParams.get('view') === 'methodology')
  const calculation = [...document.querySelectorAll('button')].find(item => item.textContent.trim() === 'Расчёт')
  calculation.click(); await pause(500)
  const employeeValueAfterReturn = inputByLabel('Сотрудников всего')?.value
  check('Возврат не сбрасывает численность', employeeValueAfterReturn === '4000', JSON.stringify({ value:employeeValueAfterReturn, url:location.href, selected:calculation.getAttribute('aria-current'), body:text().slice(0,120) }))
  result.viewport = { width: innerWidth, scrollWidth: document.documentElement.scrollWidth }
  check('Нет горизонтального переполнения desktop', result.viewport.scrollWidth <= result.viewport.width)
  return result
})()`)
console.log(JSON.stringify(report, null, 2))
socket.close()
