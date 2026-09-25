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
    descriptor.set.call(element, String(value)); element.dispatchEvent(new Event('input', { bubbles:true })); element.dispatchEvent(new Event('change', { bubbles:true })); await pause(150)
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
  const elevatorCount = inputByLabel('Количество лифтов')
  await setValue(elevatorCount, 4)
  const methodology = [...document.querySelectorAll('button')].find(item => item.textContent.trim() === 'Описание алгоритма')
  methodology.click(); await pause(100)
  check('Открывается описание алгоритма', text().includes('Как работает расчёт') && new URL(location.href).searchParams.get('view') === 'methodology')
  const calculation = [...document.querySelectorAll('button')].find(item => item.textContent.trim() === 'Расчёт')
  calculation.click(); await pause(1000)
  const employeeValueAfterReturn = inputByLabel('Сотрудников всего')?.value
  check('Возврат не сбрасывает численность', employeeValueAfterReturn === '4000' || text().includes('4000 сотрудников') || text().includes('4 000 сотрудников'), JSON.stringify({ value:employeeValueAfterReturn, url:location.href, selected:calculation.getAttribute('aria-current'), body:text().slice(0,120) }))
  const run = [...document.querySelectorAll('button')].find(item => item.textContent.includes('Запустить расчёт'))
  run?.click()
  for (let attempt = 0; attempt < 120 && !text().includes('Результаты сценария') && !text().includes('Расчёт остановлен:'); attempt += 1) await pause(500)
  check('Заполненный сценарий рассчитывается без ошибки', text().includes('Результаты сценария') && !text().includes('Расчёт остановлен:'))
  const saveCurrent = [...document.querySelectorAll('button')].find(item => item.textContent.trim() === 'Сохранить текущий')
  saveCurrent?.click(); await pause(100)
  const saveDialog = document.querySelector('.save-dialog')
  const saveName = saveDialog?.querySelector('input')
  if (saveName) await setValue(saveName, 'Проверка меню действий')
  saveDialog?.querySelector('button[type="submit"]')?.click(); await pause(150)
  const savedCard = [...document.querySelectorAll('.saved-card')].find(item => item.querySelector('h3')?.textContent === 'Проверка меню действий')
  const more = savedCard?.querySelector('details')
  more?.querySelector('summary')?.click(); await pause(50)
  const renameAction = [...(more?.querySelectorAll('button') ?? [])].find(item => item.textContent.trim() === 'Переименовать')
  renameAction?.click(); await pause(50)
  const done = savedCard?.querySelector('.rename-row button')
  const morePanel = more?.querySelector(':scope > div')
  check('Меню «Ещё» закрывается после переименования', more?.open === false && morePanel instanceof HTMLElement && getComputedStyle(morePanel).display === 'none' && Boolean(done) && done?.getBoundingClientRect().height > 0)
  const cancelRename = [...(savedCard?.querySelectorAll('.rename-row button') ?? [])].find(item => item.textContent.trim() === 'Отмена')
  cancelRename?.click(); await pause(50)
  more?.querySelector('summary')?.click(); await pause(50)
  const copyAction = [...(more?.querySelectorAll('button') ?? [])].find(item => item.textContent.trim() === 'Создать копию')
  copyAction?.click(); await pause(100)
  check('Меню «Ещё» закрывается после создания копии', more?.open === false && morePanel instanceof HTMLElement && getComputedStyle(morePanel).display === 'none')
  const comparable = [...document.querySelectorAll('.saved-card .compare-check input:not(:disabled)')].slice(0, 2)
  comparable.forEach(item => item.click()); await pause(100)
  const comparisonText = document.querySelector('.comparison')?.textContent ?? ''
  check('В сравнении сценариев показаны медианы', comparisonText.includes('Медиана ожидания') && comparisonText.includes('Медиана полного маршрута'))
  result.viewport = { width: innerWidth, scrollWidth: document.documentElement.scrollWidth }
  const overflowing = [...document.querySelectorAll('body *')].filter(item => { const box = item.getBoundingClientRect(); return box.right > innerWidth + 1 || box.left < -1 }).slice(0,10).map(item => ({ tag:item.tagName, class:item.className, text:item.textContent?.trim().slice(0,60), box:item.getBoundingClientRect().toJSON() }))
  check('Нет горизонтального переполнения desktop', result.viewport.scrollWidth <= result.viewport.width, JSON.stringify(overflowing))
  return result
})()`)
console.log(JSON.stringify(report, null, 2))
socket.close()
