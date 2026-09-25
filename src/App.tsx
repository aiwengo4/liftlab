import { useEffect, useId, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import type { BrowserSimulationResult } from './browserResult'
import { availableFloors, createDefaultScenarioForm, distributeEmployees, resizeElevators, resizeFloors, validateScenarioForm, type ScenarioFormErrors, type ScenarioFormState } from './scenarioForm'
import { ResultsView } from './ResultsView'
import { createScenarioUrl, decodeScenarioHash, encodeScenario } from './scenarioLink'
import { SavedScenariosView } from './SavedScenariosView'
import type { SavedScenario } from './savedScenarios'
import { MethodologyView } from './MethodologyView'
import { DEFAULT_LUNCH_OVERLOAD_STAIR_SETTINGS, DEFAULT_STAIR_CHOICE_SETTINGS } from './engine/routeChoice'

export function App() {
  const layoutMode = new URLSearchParams(window.location.search).get('layout')
  const groupedPreview = layoutMode !== 'legacy'
  const showPreviewBanner = layoutMode === 'grouped'
  const [activeView, setActiveView] = useState<'calculator' | 'methodology'>(() => new URLSearchParams(window.location.search).get('view') === 'methodology' ? 'methodology' : 'calculator')
  const [initialLink] = useState(() => window.location.hash.startsWith('#settings=') ? decodeScenarioHash(window.location.hash) : null)
  const [form, setForm] = useState(() => initialLink?.ok ? initialLink.scenario : createDefaultScenarioForm())
  const [submitted, setSubmitted] = useState(false)
  const [result, setResult] = useState<BrowserSimulationResult | null>(null)
  const [resultFingerprint, setResultFingerprint] = useState<string | null>(null)
  const [runError, setRunError] = useState<string | null>(null)
  const [calculating, setCalculating] = useState(false)
  const workerRef = useRef<Worker | null>(null)
  const [linkStatus, setLinkStatus] = useState<string | null>(() => initialLink && !initialLink.ok ? initialLink.reason + '. Загружены настройки по умолчанию.' : initialLink?.ok && initialLink.migrated ? 'Старая ссылка обновлена для новой модели встреч. Доступность переговорных установлена на 80%; запустите расчёт заново.' : null)
  const errors = useMemo(() => validateScenarioForm(form), [form])
  const employeeSum = form.floors.reduce((sum, floor) => sum + floor.employees, 0)
  const servedFloors = form.floors.filter((floor) => floor.served).map((floor) => floor.floor)
  const hasParkingErrors = Boolean(errors.parking) || Object.keys(errors).some((key) => key.startsWith('parking-'))
  useEffect(() => {
    setResult(null)
    if (workerRef.current) {
      workerRef.current.terminate(); workerRef.current = null; setCalculating(false)
      setRunError('Расчёт отменён, потому что настройки изменились')
    }
  }, [form])
  useEffect(() => () => workerRef.current?.terminate(), [])
  useEffect(() => {
    const loadLocation = () => {
      setActiveView(new URLSearchParams(window.location.search).get('view') === 'methodology' ? 'methodology' : 'calculator')
      if (!window.location.hash.startsWith('#settings=')) return
      const decoded = decodeScenarioHash(window.location.hash)
      if (decoded.ok) {
        setForm(decoded.scenario)
        setLinkStatus(decoded.migrated ? 'Ссылка обновлена для текущей версии модели.' : 'Настройки загружены из ссылки.')
      } else setLinkStatus(decoded.reason + '. Текущие настройки оставлены без изменений.')
    }
    const onPopState = () => loadLocation()
    const onHashChange = () => loadLocation()
    window.addEventListener('popstate', onPopState)
    window.addEventListener('hashchange', onHashChange)
    return () => { window.removeEventListener('popstate', onPopState); window.removeEventListener('hashchange', onHashChange) }
  }, [])
  const update = (patch: Partial<ScenarioFormState>, redistribute = false) => setForm((current) => {
    const next = { ...current, ...patch }
    return redistribute && next.distributionMode === 'equal' ? distributeEmployees(next) : next
  })
  const previewStops = form.servedFloorsByElevator
  const setPreviewStops: Dispatch<SetStateAction<readonly (readonly number[])[]>> = (action) => setForm((current) => ({
    ...current,
    servedFloorsByElevator: typeof action === 'function' ? action(current.servedFloorsByElevator) : action,
  }))
  const undergroundParkingEnabled = form.undergroundParkingEnabled
  const undergroundFloorCount = form.undergroundFloorCount
  const undergroundEmployeeShare = form.undergroundEmployeeShare * 100

  const run = () => {
    setSubmitted(true)
    setRunError(null)
    if (Object.keys(errors).length > 0) return
    workerRef.current?.terminate()
    const worker = new Worker(new URL('./simulation.worker.ts', import.meta.url), { type: 'module' })
    workerRef.current = worker
    setCalculating(true)
    const fingerprint = encodeScenario(form)
    worker.onmessage = (event: MessageEvent<{ ok: true; result: BrowserSimulationResult } | { ok: false; error: string }>) => {
      if (workerRef.current !== worker) return
      setCalculating(false); workerRef.current = null; worker.terminate()
      if (event.data.ok) { setResult(event.data.result); setResultFingerprint(fingerprint) }
      else { setResult(null); setRunError(event.data.error) }
    }
    worker.onerror = (event) => {
      if (workerRef.current !== worker) return
      const location = event.filename ? ` (${event.filename.split('/').pop()}:${event.lineno || '?'})` : ''
      setCalculating(false); workerRef.current = null; worker.terminate(); setResult(null); setRunError(`${event.message || 'Ошибка фонового процесса'}${location}`)
    }
    worker.postMessage(form)
  }
  const cancelRun = () => { workerRef.current?.terminate(); workerRef.current=null; setCalculating(false); setRunError('Расчёт отменён пользователем') }

  const newSeed = () => {
    const value = new Uint32Array(1)
    crypto.getRandomValues(value)
    update({ seed: value[0] })
    setResult(null)
  }
  const selectView = (view: 'calculator' | 'methodology') => {
    const url = new URL(window.location.href)
    if (view === 'methodology') url.searchParams.set('view', 'methodology'); else url.searchParams.delete('view')
    window.history.pushState(null, '', url)
    setActiveView(view)
  }
  const openSettingsSection = (id: string) => {
    const section = document.getElementById(id)
    const disclosure = section instanceof HTMLDetailsElement ? section : section?.querySelector('details')
    if (disclosure instanceof HTMLDetailsElement) disclosure.open = true
    section?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' })
  }

  const share = async (scenario: ScenarioFormState = form, updateAddress = true) => {
    const baseUrl = new URL(window.location.href)
    if (baseUrl.searchParams.get('layout') === 'grouped') baseUrl.searchParams.delete('layout')
    baseUrl.searchParams.delete('view')
    const url = createScenarioUrl(scenario, baseUrl.toString())
    try {
      await copyText(url)
      if (updateAddress) window.history.replaceState(null, '', url)
      setLinkStatus('Ссылка скопирована. В ней сохранены все настройки и номер случайного сценария.')
    } catch {
      if (updateAddress) window.history.replaceState(null, '', url)
      setLinkStatus(updateAddress ? 'Не удалось скопировать автоматически. Ссылка уже готова в адресной строке.' : 'Не удалось скопировать ссылку.')
    }
  }

  return (
    <main className={`page ${groupedPreview ? 'grouped-layout' : 'legacy-layout'}`}>
      <header className="topbar">
        <button className="brand brand-button" type="button" aria-label="Открыть расчёт" onClick={() => selectView('calculator')}><span className="brand-mark">↕</span> LiftLab</button>
        <div className="contact-links" aria-label="Контакты автора"><span>Контакты</span><a href="https://t.me/aiwengo4" target="_blank" rel="noreferrer" aria-label="Написать в Telegram" title="Telegram"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21.7 3.4 18.5 19c-.2 1.1-.9 1.4-1.8.9l-4.9-3.6-2.4 2.3c-.3.3-.5.5-1 .5l.4-5 9-8.1c.4-.4-.1-.6-.6-.2L6.1 12.8 1.3 11.3c-1-.3-1-1 .2-1.5L20.2 2.6c.9-.3 1.7.2 1.5.8Z" /></svg></a><a href="https://q.yandex-team.ru/#/user/sorokinivan" target="_blank" rel="noreferrer" aria-label="Написать в Мессенджере" title="Мессенджер"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 3h16a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H9l-5.4 3.4A1 1 0 0 1 2 20.6V5a2 2 0 0 1 2-2Zm3 6.2h10V7.5H7v1.7Zm0 4h7.5v-1.7H7v1.7Z" /></svg></a></div>
        {activeView === 'calculator' && <div className="seed-panel" aria-label="Управление случайным сценарием">
          <span>Сценарий <strong>#{form.seed}</strong></span>
          <button className="text-button" type="button" onClick={newSeed}>Пересоздать поток</button>
          <button className="share-button" type="button" onClick={() => void share()}>Скопировать ссылку</button>
        </div>}
      </header>
      <section className="view-switcher-panel" id="top"><nav className="view-tabs" aria-label="Разделы сайта"><button type="button" aria-current={activeView === 'calculator' ? 'page' : undefined} onClick={() => selectView('calculator')}>Расчёт</button><button type="button" aria-current={activeView === 'methodology' ? 'page' : undefined} onClick={() => selectView('methodology')}>Описание алгоритма</button></nav>{activeView === 'calculator' && <div className="scenario-summary"><span>{form.floorCount} {plural(form.floorCount, 'этаж', 'этажа', 'этажей')}</span><span>{form.elevatorCount} {plural(form.elevatorCount, 'лифт', 'лифта', 'лифтов')}</span><span>{employeeSum} {plural(employeeSum, 'сотрудник', 'сотрудника', 'сотрудников')}</span></div>}</section>
      {activeView === 'methodology' ? <MethodologyView /> : <>
      {linkStatus && <div className="link-status" role="status"><span>{linkStatus}</span><button type="button" aria-label="Скрыть сообщение" onClick={() => setLinkStatus(null)}>×</button></div>}
      {showPreviewBanner && <div className="preview-banner" role="status"><span><strong>Этот вариант утверждён:</strong> такая компоновка теперь используется по умолчанию</span><a href={window.location.pathname + window.location.hash}>Открыть основной адрес</a></div>}
      {groupedPreview && <nav className="settings-toc" aria-label="Оглавление настроек"><strong>Оглавление</strong><button type="button" onClick={() => openSettingsSection('settings-people')}><b>01</b><span>Численность</span></button><button type="button" onClick={() => openSettingsSection('settings-elevators')}><b>02</b><span>Лифты</span></button><button type="button" onClick={() => openSettingsSection('settings-schedule')}><b>03</b><span>Расписание</span></button><button type="button" onClick={() => openSettingsSection('settings-stairs')}><b>04</b><span>Лестница</span></button><button type="button" onClick={() => openSettingsSection('settings-report')}><b>05</b><span>Результаты</span></button></nav>}

      <form onSubmit={(event) => { event.preventDefault(); run() }} noValidate>
        <details className="section-card top-disclosure" id="settings-people">
          <summary className="section-heading"><span className="section-number">01</span><span><strong id="building-title">Здание и размещение сотрудников</strong><small>Этажность, столовая и рабочие места · {employeeSum} сотрудников</small></span></summary>
          <div className="field-grid three">
            <NumberField label="Количество этажей" value={form.floorCount} min={2} max={100} error={submitted ? errors.floorCount : undefined} onChange={(floorCount) => setForm((current) => resizeFloors(current, floorCount))} />
            <NumberField label="Сотрудников всего" value={form.totalEmployees} min={0} max={10000} error={errors.totalEmployees} onChange={(totalEmployees) => update({ totalEmployees }, true)} />
            <label className="field"><span>Этаж столовой</span><select value={form.cafeteriaFloor} onChange={(event) => update({ cafeteriaFloor: Number(event.target.value) })}>{form.floors.map(({ floor }) => <option key={floor} value={floor}>{floor} этаж</option>)}</select></label>
          </div>
          <fieldset className="segmented-field"><legend>Как заполнить этажи</legend><div className="segmented">
            <button type="button" aria-pressed={form.distributionMode === 'manual'} className={form.distributionMode === 'manual' ? 'active' : ''} onClick={() => update({ distributionMode: 'manual' })}>Вручную</button>
            <button type="button" aria-pressed={form.distributionMode === 'equal'} className={form.distributionMode === 'equal' ? 'active' : ''} onClick={() => setForm((current) => distributeEmployees({ ...current, distributionMode: 'equal' }))}>Поровну</button>
          </div></fieldset>
          {groupedPreview && <div className="underground-control"><label className="check-line"><input type="checkbox" checked={undergroundParkingEnabled} onChange={(event) => setForm((current) => { const enabled = event.target.checked; const underground = enabled ? Array.from({ length: current.undergroundFloorCount }, (_, index) => -(index + 1)) : []; return { ...current, undergroundParkingEnabled: enabled, servedFloorsByElevator: current.servedFloorsByElevator.map((floors) => [...new Set([...floors.filter((floor) => floor > 0), ...underground])].sort((a,b) => a-b)) } })} />Добавить подземные этажи парковки</label>{undergroundParkingEnabled && <><NumberField label="Количество подземных этажей" value={undergroundFloorCount} min={1} max={4} error={errors.undergroundFloorCount} onChange={(value) => setForm((current) => { const count = value; const allowed = new Set([...Array.from({ length: Math.max(0, Math.trunc(count)) }, (_, index) => -(index + 1)), ...current.floors.map(({ floor }) => floor)]); const underground = Number.isSafeInteger(count) && count >= 1 && count <= 4 ? Array.from({ length: count }, (_, index) => -(index + 1)) : []; return { ...current, undergroundFloorCount: count, servedFloorsByElevator: current.servedFloorsByElevator.map((floors) => [...new Set([...floors.filter((floor) => allowed.has(floor)), ...underground, 1])].sort((a,b) => a-b)) } })} /><NumberField label="Доля сотрудников, приезжающих на парковку" suffix="%" value={undergroundEmployeeShare} min={0} max={100} step={0.1} error={errors.undergroundEmployeeShare ?? errors.undergroundParking} onChange={(value) => update({ undergroundEmployeeShare: value / 100 })} hint="Утром эти сотрудники начинают маршрут с парковки, вечером возвращаются на тот же подземный этаж." /></>}<p className="hint">Подземные этажи обозначаются как −1…−4. Рабочие места на них не размещаются; сотрудники распределяются между добавленными парковочными этажами равномерно.</p></div>}
          {form.distributionMode === 'equal' && <label className="check-line"><input type="checkbox" checked={form.includeFirstFloor} onChange={(event) => setForm((current) => distributeEmployees({ ...current, includeFirstFloor: event.target.checked }))} />Распределять сотрудников и на первый этаж</label>}
          {groupedPreview ? <EmployeeFloorColumns form={form} update={update} /> : <div className="floor-table" aria-label="Настройки этажей">
            <div className="floor-row floor-head"><span>Этаж</span><span>Сотрудники</span>{!groupedPreview && <span>Остановка</span>}</div>
            {[...form.floors].reverse().map((floorValue) => <div className="floor-row" key={floorValue.floor}>
              <strong>{floorValue.floor}</strong>
              <EditableNumberInput ariaLabel={`Сотрудники на этаже ${floorValue.floor}`} min={0} step={1} value={floorValue.employees} invalid={!Number.isSafeInteger(floorValue.employees) || floorValue.employees < 0 || floorValue.employees > 10000} disabled={form.distributionMode === 'equal'} onValueChange={(employees) => update({ floors: form.floors.map((floor) => floor.floor === floorValue.floor ? { ...floor, employees } : floor) })} />
              {!groupedPreview && <label className="switch"><input aria-label={`Остановка на этаже ${floorValue.floor}`} type="checkbox" checked={floorValue.served} disabled={floorValue.floor === 1} onChange={(event) => update({ floors: form.floors.map((floor) => floor.floor === floorValue.floor ? { ...floor, served: event.target.checked } : floor), initialElevatorFloors: event.target.checked ? form.initialElevatorFloors : form.initialElevatorFloors.map((start) => start === floorValue.floor ? 1 : start), parkingByElevator: event.target.checked ? form.parkingByElevator : form.parkingByElevator.map((parking) => ({ ...parking, intervals: parking.intervals.map((interval) => interval.floor === floorValue.floor ? { ...interval, floor: 1 } : interval) })) })} /><span /></label>}
            </div>)}
          </div>}
          <div className={`sum-line ${errors.floors ? 'has-error' : ''}`}><span>Распределено по этажам</span><strong>{employeeSum} из {form.totalEmployees}</strong></div>
          {errors.floors && <p className="field-error" role="alert">{errors.floors}</p>}
          <p className="hint">Ноль означает, что этаж пустой или его занимает другая компания.{!groupedPreview && ' Первый этаж всегда доступен лифтам.'}</p>
        </details>

        <details className="section-card top-disclosure" id="settings-elevators">
          <summary className="section-heading"><span className="section-number">02</span><span><strong id="elevators-title">Лифты и правила их работы</strong><small>Количество, вместимость, остановки и алгоритм управления</small></span></summary>
          <div className="field-grid two">
            <NumberField label="Количество лифтов" value={form.elevatorCount} min={1} max={20} error={submitted ? errors.elevatorCount : undefined} onChange={(count) => setForm((current) => resizeElevators(current, count))} />
            <NumberField label="Вместимость" suffix="чел." value={form.elevatorCapacity} min={1} max={40} error={submitted ? errors.elevatorCapacity : undefined} onChange={(elevatorCapacity) => update({ elevatorCapacity })} />
          </div>
          <div className="strategy-control">
            <label className="field"><span>Алгоритм управления лифтами</span><select value={form.dispatchStrategy} onChange={(event) => update({ dispatchStrategy: event.target.value as ScenarioFormState['dispatchStrategy'] })}><option value="global-fifo">Сначала самый ранний вызов</option><option value="nearest">Сначала ближайший вызов</option><option value="hybrid">Гибридный алгоритм</option></select></label>
            <div className="strategy-explanation"><strong>{dispatchStrategyCopy(form.dispatchStrategy).title}</strong><p>{dispatchStrategyCopy(form.dispatchStrategy).description}</p><small>{dispatchStrategyCopy(form.dispatchStrategy).effect}</small></div>
          </div>
          <div className={`elevator-cards ${groupedPreview ? 'preview-elevator-cards' : ''}`}>{form.initialElevatorFloors.map((floor, index) => {
            const selectableFloors = availableFloors(form)
            return groupedPreview ? <div className="preview-elevator-card" key={index}>
              <label className="elevator-card"><span className="lift-icon">↕</span><span><strong>Лифт {index + 1}</strong><small>Начальный этаж</small></span><select value={floor} aria-invalid={Boolean(errors[`elevator-${index}`])} onChange={(event) => update({ initialElevatorFloors: form.initialElevatorFloors.map((value, current) => current === index ? Number(event.target.value) : value) })}>{(previewStops[index] ?? [1]).map((served) => <option value={served} key={served}>{served}</option>)}</select></label>
              <details className="nested-disclosure"><summary>Этажи остановок</summary><StopPresetControls elevatorIndex={index} floorCount={form.floorCount} undergroundFloorCount={undergroundParkingEnabled ? undergroundFloorCount : 0} initialElevatorFloor={floor} setPreviewStops={setPreviewStops} /><div className="stop-floor-grid">{selectableFloors.map((stopFloor) => <label key={stopFloor}><input type="checkbox" checked={(previewStops[index] ?? []).includes(stopFloor)} disabled={stopFloor === 1 || stopFloor === floor} onChange={(event) => setPreviewStops((current) => current.map((stops,currentIndex) => currentIndex !== index ? stops : event.target.checked ? [...stops, stopFloor].sort((a,b) => a-b) : stops.filter((item) => item !== stopFloor)))} />{stopFloor}</label>)}</div>{errors[`elevator-stops-${index}`] && <span className="field-error">{errors[`elevator-stops-${index}`]}</span>}<p className="hint">Первый и начальный этажи всегда доступны этому лифту.</p></details>
            </div> : <label className="elevator-card" key={index}><span className="lift-icon">↕</span><span><strong>Лифт {index + 1}</strong><small>Начальный этаж</small></span><select value={floor} aria-invalid={Boolean(errors[`elevator-${index}`])} onChange={(event) => update({ initialElevatorFloors: form.initialElevatorFloors.map((value, current) => current === index ? Number(event.target.value) : value) })}>{servedFloors.map((served) => <option value={served} key={served}>{served}</option>)}</select></label>
          })}</div>
          {groupedPreview && <div className="preview-note">Подземная парковка участвует в утренних и вечерних маршрутах. Диспетчер назначает поездку только лифту, который обслуживает этаж посадки и пункт назначения.</div>}
          <details className="disclosure"><summary><span>Скорость движения и работа дверей</span><small>{form.secondsPerFloor} с/этаж · двери {form.doorOperationSeconds} с</small></summary><div className="details-body field-grid three">
            <NumberField label="Время движения между соседними этажами" suffix="сек." value={form.secondsPerFloor} min={0.5} max={30} step={0.1} error={submitted ? errors.secondsPerFloor : undefined} onChange={(secondsPerFloor) => update({ secondsPerFloor })} />
            <NumberField label="Суммарное время разгона и торможения" suffix="сек." value={form.accelerationAndBrakingSeconds} min={0} max={30} step={0.1} error={submitted ? errors.accelerationAndBrakingSeconds : undefined} onChange={(accelerationAndBrakingSeconds) => update({ accelerationAndBrakingSeconds })} />
            <NumberField label="Открытие и закрытие дверей" suffix="сек." value={form.doorOperationSeconds} min={0} max={30} step={0.1} error={submitted ? errors.doorOperationSeconds : undefined} onChange={(doorOperationSeconds) => update({ doorOperationSeconds })} hint="Время применяется отдельно к открытию и отдельно к закрытию дверей." />
            <NumberField label="Ожидание с открытыми дверями" suffix="сек." value={form.openDoorDwellSeconds} min={0} max={60} step={0.1} error={submitted ? errors.openDoorDwellSeconds : undefined} onChange={(openDoorDwellSeconds) => update({ openDoorDwellSeconds })} />
            <NumberField label="Посадка или высадка пассажира" suffix="сек." value={form.passengerTransferSeconds} min={0} max={5} step={0.1} error={submitted ? errors.passengerTransferSeconds : undefined} onChange={(passengerTransferSeconds) => update({ passengerTransferSeconds })} />
          </div></details>
          {groupedPreview && <><ParkingSettings form={form} errors={errors} submitted={submitted} servedFloors={servedFloors} update={update} />{hasParkingErrors && <p className="field-error section-visible-error" role="alert">Проверьте периоды, этажи и время ожидания в настройках парковки лифтов.</p>}</>}
        </details>

        <details className="section-card top-disclosure" id="settings-schedule">
          <summary className="section-heading"><span className="section-number">03</span><span><strong id="flow-title">Время прихода, ухода и дневных перемещений</strong><small>Когда сотрудники приходят, встречаются, обедают и уходят</small></span></summary>
          {groupedPreview && <p className="section-intro">Настройте расписание событий, которые создают нагрузку на лифты в течение рабочего дня.</p>}
          <details className="disclosure" open><summary><span>Приход сотрудников</span>{errors.arrival && <b className="error-badge">Есть ошибка</b>}<small>{Math.round(form.arrivalPrimaryShare * 100)}% с {formatTime(form.arrivalPrimaryStart)} до {formatTime(form.arrivalPrimaryEnd)}</small></summary><div className="details-body time-grid">
            <div className="peak-bias-control span-all">
              <div className="peak-bias-heading"><label className="check-line"><input type="checkbox" checked={form.wholeHourBiasEnabled} onChange={(event) => update({ wholeHourBiasEnabled: event.target.checked })} />Распределить приход/уход около целых часов</label><button type="button" className="help-tooltip settings-help-tooltip" aria-label="Как работают пики около целых часов?">?<span role="tooltip"><strong>Как работает настройка</strong><br /><br />Она применяется к приходу и уходу, но только к сотрудникам, попавшим за пределы основного окна. События внутри основного окна остаются распределёнными равномерно.<br /><br /><strong>Пример.</strong> Если 80% сотрудников приходят с 09:00 до 12:00, настройка затрагивает оставшиеся 20%. При доле смещения 50% пики получит примерно половина этой группы — около 10% всех сотрудников.<br /><br />Для выбранного события модель берёт целый час в соответствующей части общего периода и добавляет случайное отклонение от −10 до +5 минут. Время не может выйти за общий период или попасть внутрь основного окна. Если подходящее смещение не найдено, сохраняется исходное равномерно выбранное время.<br /><br />Одинаковый номер сценария даёт одинаковые времена. Кнопка обновления сценария создаёт новое распределение.</span></button></div>
              {form.wholeHourBiasEnabled && <NumberField label="Доля событий со смещением" suffix="%" value={form.wholeHourBiasShare * 100} min={0} max={100} step={1} error={submitted ? errors.wholeHourBiasShare : undefined} onChange={(value) => update({ wholeHourBiasShare: value / 100 })} />}
            </div>
            <TimeField label="Начало общего периода" value={form.arrivalOverallStart} invalid={Boolean(errors.arrival)} onChange={(arrivalOverallStart) => update({ arrivalOverallStart })} />
            <TimeField label="Окончание общего периода" value={form.arrivalOverallEnd} invalid={Boolean(errors.arrival)} onChange={(arrivalOverallEnd) => update({ arrivalOverallEnd })} />
            <TimeField label="Начало основного окна" value={form.arrivalPrimaryStart} invalid={Boolean(errors.arrival)} onChange={(arrivalPrimaryStart) => update({ arrivalPrimaryStart })} />
            <TimeField label="Окончание основного окна" value={form.arrivalPrimaryEnd} invalid={Boolean(errors.arrival)} onChange={(arrivalPrimaryEnd) => update({ arrivalPrimaryEnd })} />
            <NumberField label="Доля в основном окне" suffix="%" value={form.arrivalPrimaryShare * 100} min={0} max={100} error={submitted ? errors.arrivalPrimaryShare : undefined} onChange={(value) => update({ arrivalPrimaryShare: value / 100 })} />
            {errors.arrival && <p className="field-error span-all" role="alert">{errors.arrival}</p>}
          </div></details>
          <details className="disclosure"><summary><span>Уход сотрудников</span>{errors.departure && <b className="error-badge">Есть ошибка</b>}<small>{Math.round(form.departurePrimaryShare * 100)}% с {formatTime(form.departurePrimaryStart)} до {formatTime(form.departurePrimaryEnd)}</small></summary><div className="details-body time-grid">
            <TimeField label="Начало общего периода" value={form.departureOverallStart} invalid={Boolean(errors.departure)} onChange={(departureOverallStart) => update({ departureOverallStart })} />
            <TimeField label="Окончание общего периода" value={form.departureOverallEnd} invalid={Boolean(errors.departure)} onChange={(departureOverallEnd) => update({ departureOverallEnd })} />
            <TimeField label="Начало основного окна" value={form.departurePrimaryStart} invalid={Boolean(errors.departure)} onChange={(departurePrimaryStart) => update({ departurePrimaryStart })} />
            <TimeField label="Окончание основного окна" value={form.departurePrimaryEnd} invalid={Boolean(errors.departure)} onChange={(departurePrimaryEnd) => update({ departurePrimaryEnd })} />
            <NumberField label="Доля в основном окне" suffix="%" value={form.departurePrimaryShare * 100} min={0} max={100} error={submitted ? errors.departurePrimaryShare : undefined} onChange={(value) => update({ departurePrimaryShare: value / 100 })} />
            <NumberField label="Влияние раннего прихода" suffix="%" value={form.arrivalInfluenceOnDeparture * 100} min={0} max={100} error={submitted ? errors.arrivalInfluenceOnDeparture : undefined} onChange={(value) => update({ arrivalInfluenceOnDeparture: value / 100 })} hint="Чем выше значение, тем вероятнее раньше уйдут те, кто раньше пришёл. Уход раньше прихода запрещён." />
            {errors.departure && <p className="field-error span-all" role="alert">{errors.departure}</p>}
          </div></details>
          <details className="disclosure"><summary><span>Рабочие встречи</span>{errors.meeting && <b className="error-badge">Есть ошибка</b>}<small>Время проведения · в среднем {form.meanMeetingsPerEmployee} на сотрудника</small></summary><div className="details-body time-grid"><TimeField label="Начало периода встреч" value={form.meetingStart} invalid={Boolean(errors.meeting)} onChange={(meetingStart) => update({ meetingStart })} /><TimeField label="Окончание периода встреч" value={form.meetingEnd} invalid={Boolean(errors.meeting)} onChange={(meetingEnd) => update({ meetingEnd })} />{errors.meeting && <p className="field-error span-all inline-window-error" role="alert">{errors.meeting}</p>}</div>{groupedPreview && <MeetingSettings form={form} errors={errors} submitted={submitted} update={update} />}</details>
          <details className="disclosure"><summary><span>Обеденный перерыв</span>{errors.lunch && <b className="error-badge">Есть ошибка</b>}<small>Время выхода, пик нагрузки и доля сотрудников</small></summary><div className="details-body time-grid"><TimeField label="Начало периода обедов" value={form.lunchStart} invalid={Boolean(errors.lunch)} onChange={(lunchStart) => update({ lunchStart })} /><TimeField label="Окончание периода обедов" value={form.lunchEnd} invalid={Boolean(errors.lunch)} onChange={(lunchEnd) => update({ lunchEnd })} /><TimeField label="Пиковое время выхода" value={form.lunchPeak} invalid={Boolean(errors.lunch)} onChange={(lunchPeak) => update({ lunchPeak })} /><NumberField label="Доля сотрудников, идущих на обед" suffix="%" value={form.lunchShare * 100} min={0} max={100} error={errors.lunchShare} onChange={(value) => update({ lunchShare: value / 100 })} />{errors.lunch && <p className="field-error span-all inline-window-error" role="alert">{errors.lunch}</p>}</div>{groupedPreview && <LunchSettings form={form} errors={errors} submitted={submitted} update={update} />}</details>
          {!groupedPreview && <details className="disclosure"><summary><span>Лестница</span><small>{form.stairSecondsPerFloor} с/этаж · {form.stairsConvenient ? 'удобная' : 'неудобная'}</small></summary><div className="details-body"><NumberField label="Время на один этаж" suffix="сек." value={form.stairSecondsPerFloor} min={1} max={120} step={0.1} error={submitted ? errors.stairSecondsPerFloor : undefined} onChange={(stairSecondsPerFloor) => update({ stairSecondsPerFloor })} /><p className="hint strong">Базовый алгоритм использует отдельные кнопки «вверх» и «вниз». Общая кнопка будет добавлена вместе с альтернативным алгоритмом диспетчеризации.</p></div></details>}
          </details>

        {groupedPreview && <details className="section-card top-disclosure" id="settings-stairs"><summary className="section-heading"><span className="section-number">04</span><span><strong>Настройка движения по лестнице</strong><small>Скорость, удобство и вероятность выбора вместо лифта</small></span></summary><p className="section-intro">Эти параметры определяют, когда сотрудники пойдут пешком и сколько времени займёт переход между этажами.</p><div className="field-grid two"><NumberField label="Время спуска или подъёма на один этаж" suffix="сек." value={form.stairSecondsPerFloor} min={1} max={120} step={0.1} error={submitted ? errors.stairSecondsPerFloor : undefined} onChange={(stairSecondsPerFloor) => update({ stairSecondsPerFloor })} /></div><StairSettings form={form} errors={errors} submitted={submitted} update={update} /></details>}

        {groupedPreview && <div id="settings-report"><ReportSettings form={form} errors={errors} update={update} />{(errors.reportArrivalWarning || errors.reportDepartureWarning) && <div className="warning report-preview-warning" role="alert">Проверьте границы периодов результатов: {errors.reportArrivalWarning ?? errors.reportDepartureWarning}.</div>}</div>}

        {!groupedPreview && <details className="section-card top-disclosure">
          <summary className="section-heading"><span className="section-number">04</span><span><strong id="advanced-title">Расширенные настройки</strong><small>Встречи, лестница, отчёты и парковка</small></span></summary>
          <details className="disclosure"><summary><span>Календари и доступность переговорных</span>{(errors.meanMeetingsPerEmployee || errors.maxMeetingConcurrentShare || errors.meetingDurationShares || errors.meetingRoomFoundSharesByHour) && <b className="error-badge">Есть ошибка</b>}<small>{form.meanMeetingsPerEmployee} встречи · {meetingAvailabilitySummary(form)}</small></summary><div className="details-body">
            <div className="field-grid two"><NumberField label="Среднее встреч на сотрудника" value={form.meanMeetingsPerEmployee} min={0} max={10} step={0.1} error={submitted ? errors.meanMeetingsPerEmployee : undefined} onChange={(meanMeetingsPerEmployee) => update({ meanMeetingsPerEmployee })} hint="Можно дробное: 2,5 означает в среднем две–три встречи за день." /><NumberField label="Максимум участников одновременно" suffix="%" value={form.maxMeetingConcurrentShare * 100} min={0} max={100} error={submitted ? errors.maxMeetingConcurrentShare : undefined} onChange={(value) => update({ maxMeetingConcurrentShare: value / 100 })} hint="Выбираются только сотрудники, свободные в этот момент." /></div>
            <DistributionEditor legend="Продолжительность встреч" labels={['30 минут','45 минут','60 минут']} values={form.meetingDurationShares} error={errors.meetingDurationShares} onChange={(meetingDurationShares) => update({ meetingDurationShares: meetingDurationShares as [number,number,number] })} />
            <details className="nested-disclosure"><summary>Вероятность найти переговорную по часам</summary><p className="hint">Вероятность применяется независимо к каждой встрече по плановому часу её начала. 80% — ожидаемая доля на большом числе встреч.</p><button className="secondary-button" type="button" onClick={() => update({ meetingRoomFoundSharesByHour: Array(24).fill(0.8) })}>Установить 80% для всех часов</button><div className="field-grid two">{Array.from({ length: Math.max(0, Math.ceil(form.meetingEnd / 60) - Math.floor(form.meetingStart / 60)) }, (_, index) => Math.floor(form.meetingStart / 60) + index).filter((hour) => hour >= 0 && hour < 24).map((hour) => <NumberField key={hour} label={`${String(hour).padStart(2,'0')}:00–${String(hour + 1).padStart(2,'0')}:00`} suffix="%" value={form.meetingRoomFoundSharesByHour[hour] * 100} min={0} max={100} error={submitted && (form.meetingRoomFoundSharesByHour[hour] < 0 || form.meetingRoomFoundSharesByHour[hour] > 1) ? 'Укажите от 0 до 100%' : undefined} onChange={(value) => update({ meetingRoomFoundSharesByHour: form.meetingRoomFoundSharesByHour.map((item,index) => index === hour ? value / 100 : item) })} />)}</div>{submitted && errors.meetingRoomFoundSharesByHour && <p className="field-error">{errors.meetingRoomFoundSharesByHour}</p>}</details>
            <p className="hint">Если переговорная не найдена, сотрудник уже совершил перемещение: половина сразу возвращается на рабочий этаж, половина остаётся на достигнутом этаже до конца слота и затем возвращается. Количество и занятость конкретных комнат не моделируются.</p>
          </div></details>
          <details className="disclosure"><summary><span>Обед</span>{(errors.lunchDurationMinutes || errors.lunchDurationJitterMinutes || errors.lunchWaveMinutes) && <b className="error-badge">Есть ошибка</b>}<small>{form.lunchDurationMinutes} ± {form.lunchDurationJitterMinutes} мин. · волна {form.lunchWaveMinutes} мин.</small></summary><div className="details-body"><div className="field-grid three"><NumberField label="Продолжительность обеда" suffix="мин." value={form.lunchDurationMinutes} min={15} max={60} error={submitted ? errors.lunchDurationMinutes : undefined} onChange={(lunchDurationMinutes) => update({ lunchDurationMinutes })} hint="Время от начала движения в столовую до начала возвращения." /><NumberField label="Случайный разброс" suffix="± мин." value={form.lunchDurationJitterMinutes} min={0} max={15} step={0.1} error={submitted ? errors.lunchDurationJitterMinutes : undefined} onChange={(lunchDurationJitterMinutes) => update({ lunchDurationJitterMinutes })} hint="Каждому сотруднику независимо добавляется или вычитается до указанного времени. Итог ограничен 15–60 минутами." /><NumberField label="Ширина волны" suffix="мин." value={form.lunchWaveMinutes} min={5} max={120} step={0.1} error={submitted ? errors.lunchWaveMinutes : undefined} onChange={(lunchWaveMinutes) => update({ lunchWaveMinutes })} hint="Чем меньше значение, тем плотнее люди выходят около пика." /></div><p className="hint">Начало моделируется с точностью до секунды, продолжительность — также с секундной точностью. График агрегирует события в более крупные интервалы.</p></div></details>
          <details className="disclosure"><summary><span>Лестница</span>{(errors.maxVoluntaryStairFloors || errors.convenientStairProbabilities || errors.inconvenientStairProbabilities || errors.lunchOverloadStairProbabilities || errors.inconvenientStairFactor) && <b className="error-badge">Есть ошибка</b>}<small>{form.stairsConvenient ? 'удобная' : `неудобная ×${form.inconvenientStairFactor}`} · перегруз {form.lunchOverloadStairsEnabled ? 'учитывается' : 'выключен'}</small></summary><div className="details-body"><label className="check-line"><input type="checkbox" checked={form.stairsConvenient} onChange={(event) => update({ stairsConvenient: event.target.checked })} />Лестницей удобно пользоваться</label><p className="hint">Для удобной лестницы используются исходные вероятности. Для неудобной они умножаются на коэффициент ниже: при значении 0,5 лестницу выбирают вдвое реже.</p><NumberField label="Коэффициент неудобной лестницы" value={form.inconvenientStairFactor} min={0} max={1} step={0.1} error={submitted ? errors.inconvenientStairFactor : undefined} onChange={(inconvenientStairFactor) => update({ inconvenientStairFactor })} /><NumberField label="Максимальный добровольный путь" suffix="эт." value={form.maxVoluntaryStairFloors} min={1} max={6} error={submitted ? errors.maxVoluntaryStairFloors : undefined} onChange={(maxVoluntaryStairFloors) => update({ maxVoluntaryStairFloors })} /><details className="nested-disclosure"><summary>Обычный выбор лестницы</summary><DistributionEditor legend="Удобная лестница" labels={['1 этаж','2 этажа','3 этажа','4 этажа','5 этажей','6 этажей']} values={form.convenientStairProbabilities} disabledAfter={form.maxVoluntaryStairFloors} error={errors.convenientStairProbabilities} requireTotal={false} onChange={(convenientStairProbabilities) => update({ convenientStairProbabilities })} /><DistributionEditor legend="Неудобная лестница" labels={['1 этаж','2 этажа','3 этажа','4 этажа','5 этажей','6 этажей']} values={form.inconvenientStairProbabilities} disabledAfter={form.maxVoluntaryStairFloors} error={errors.inconvenientStairProbabilities} requireTotal={false} onChange={(inconvenientStairProbabilities) => update({ inconvenientStairProbabilities })} /></details><details className="nested-disclosure"><summary>Спуск на обед при перегрузе</summary><label className="check-line"><input type="checkbox" checked={form.lunchOverloadStairsEnabled} onChange={(event) => update({ lunchOverloadStairsEnabled: event.target.checked })} />Предлагать лестницу при перегруженной очереди</label><p className="hint">Перегруз — перед сотрудником ожидает не меньше 1,5 вместимости одного лифта. Решение принимается один раз только при спуске в столовую.</p><DistributionEditor legend="Вероятность для удобной лестницы" labels={['1 этаж','2 этажа','3 этажа','4 этажа','5 этажей','6 этажей','7+ этажей']} values={form.lunchOverloadStairProbabilities} error={errors.lunchOverloadStairProbabilities} requireTotal={false} minPercent={5} onChange={(lunchOverloadStairProbabilities) => update({ lunchOverloadStairProbabilities })} /><p className="hint">Для неудобной лестницы эти значения умножаются на {form.inconvenientStairFactor}. Минимум исходной шкалы — 5%.</p></details><p className="hint">Обязательная лестница до разрешённой остановки от этих вероятностей не зависит.</p></div></details>
          <details className="disclosure"><summary><span>Отчётные периоды и пороги</span>{(errors.reportPeriods || errors.reportArrivalWarning || errors.reportDepartureWarning || errors.longWaitThresholds) && <b className="error-badge">Есть ошибка</b>}<small>{formatTime(form.reportMorningStart)}–{formatTime(form.reportDayStart)} · {formatTime(form.reportDayStart)}–{formatTime(form.reportEveningStart)} · {formatTime(form.reportEveningStart)}–{formatTime(form.reportEveningEnd)}</small></summary><div className="details-body"><div className="time-grid"><TimeField label="Начало утра" value={form.reportMorningStart} onChange={(reportMorningStart) => update({ reportMorningStart })} /><TimeField label="Начало дня" value={form.reportDayStart} onChange={(reportDayStart) => update({ reportDayStart })} /><TimeField label="Начало вечера" value={form.reportEveningStart} onChange={(reportEveningStart) => update({ reportEveningStart })} /><TimeField label="Конец вечера" value={form.reportEveningEnd} onChange={(reportEveningEnd) => update({ reportEveningEnd })} /></div>{errors.reportPeriods && <p className="field-error">{errors.reportPeriods}</p>}{errors.reportArrivalWarning && <div className="warning" role="alert">{errors.reportArrivalWarning}. Измените границу периода или основное окно прихода.</div>}{errors.reportDepartureWarning && <div className="warning" role="alert">{errors.reportDepartureWarning}. Измените границу периода или основное окно ухода.</div>}<div className="field-grid three">{form.longWaitThresholds.map((value,index) => <NumberField key={index} label={`Долгое ожидание ${index+1}`} suffix="сек." value={value} min={1} max={36000} onChange={(next) => update({ longWaitThresholds: form.longWaitThresholds.map((item,current) => current === index ? next : item) as [number,number,number] })} />)}</div>{errors.longWaitThresholds && <p className="field-error">{errors.longWaitThresholds}</p>}</div></details>
          <details className="disclosure"><summary><span>Парковка лифтов</span>{hasParkingErrors && <b className="error-badge">Есть ошибка</b>}<small>{form.parkingByElevator.filter((item) => item.enabled).length === 0 ? 'выключена' : `${form.parkingByElevator.filter((item) => item.enabled).length} из ${form.elevatorCount} лифтов`}</small></summary>
            <div className="details-body parking-list">
              <p className="hint">Если нет вызовов, лифт после тайм-аута едет на указанный этаж. Рабочие вызовы всегда важнее.</p>
              {form.parkingByElevator.map((parking,elevatorIndex) => {
                const parkingError = errors[`parking-${elevatorIndex}`]
                return <div className={`parking-card ${parkingError ? 'has-error' : ''}`} key={elevatorIndex} role="group" aria-labelledby={`parking-elevator-${elevatorIndex}`}>
                  <div className="parking-card-head"><strong id={`parking-elevator-${elevatorIndex}`}>Лифт {elevatorIndex+1}</strong><label className="check-line"><input type="checkbox" checked={parking.enabled} onChange={(event) => update({ parkingByElevator: form.parkingByElevator.map((item,index) => index === elevatorIndex ? { ...item, enabled: event.target.checked } : item) })} />Парковать по расписанию</label></div>
                  {parking.enabled && <>
                    <NumberField label="Тайм-аут без вызовов" suffix="сек." value={parking.timeoutSeconds} min={0} max={3600} onChange={(timeoutSeconds) => update({ parkingByElevator: form.parkingByElevator.map((item,index) => index === elevatorIndex ? { ...item, timeoutSeconds } : item) })} hint="0 — начать возврат сразу; максимум — 3600 секунд." />
                    {parking.intervals.length === 0 && <p className="parking-empty">Добавьте период, этаж и время его действия.</p>}
                    {parking.intervals.map((interval,intervalIndex) => <div className="parking-interval" key={intervalIndex}><TimeField label="С" value={interval.startMinute} invalid={Boolean(parkingError)} onChange={(startMinute) => updateParkingInterval(elevatorIndex, intervalIndex, { startMinute }, form, update)} /><TimeField label="До" value={interval.endMinute} invalid={Boolean(parkingError)} onChange={(endMinute) => updateParkingInterval(elevatorIndex, intervalIndex, { endMinute }, form, update)} /><label className="field"><span>Этаж</span><select value={interval.floor} aria-invalid={Boolean(parkingError)} onChange={(event) => updateParkingInterval(elevatorIndex, intervalIndex, { floor: Number(event.target.value) }, form, update)}>{form.servedFloorsByElevator[elevatorIndex].map((floor) => <option key={floor} value={floor}>{floor}</option>)}</select></label><button className="remove-button" type="button" aria-label={`Удалить интервал ${intervalIndex+1} лифта ${elevatorIndex+1}`} onClick={() => update({ parkingByElevator: form.parkingByElevator.map((item,index) => index === elevatorIndex ? { ...item, intervals: item.intervals.filter((_,current) => current !== intervalIndex) } : item) })}>Удалить</button></div>)}
                    <button className="secondary-button" type="button" onClick={() => addParkingInterval(elevatorIndex, form, update)}>+ Добавить период</button>
                    {submitted && parkingError && <p className="field-error" role="alert">{parkingError}</p>}
                  </>}
                </div>
              })}
            </div>
          </details>
        </details>}

        <section className="run-panel">
          <div><strong>{calculating ? 'Расчёт выполняется в фоне' : form.totalEmployees === 0 ? 'Сценарий пока не готов' : Object.keys(errors).length ? 'Проверьте настройки' : 'Можно запускать расчёт'}</strong><span>{calculating ? 'Интерфейс остаётся доступен; дождитесь результата или отмените расчёт.' : form.totalEmployees > 1000 ? 'Большой сценарий обычно рассчитывается за несколько секунд.' : form.totalEmployees === 0 ? 'Укажите количество сотрудников по этажам.' : `Seed #${form.seed} сохранит этот поток воспроизводимым.`}</span></div>
          {calculating ? <button className="cancel-button" type="button" onClick={cancelRun}>Отменить расчёт</button> : <button className="primary-button" type="submit" disabled={form.totalEmployees === 0}>Запустить расчёт <span>→</span></button>}
        </section>
        {calculating && <div className="calculation-progress" role="status"><span className="progress-spinner" aria-hidden="true" />Симуляция рабочего дня выполняется…</div>}
        {submitted && Object.keys(errors).length > 0 && <div className="error-summary" role="alert">Не удалось запустить: исправьте отмеченные настройки ({Object.keys(errors).length}).</div>}
        {runError && <div className="error-summary" role="alert">Расчёт остановлен: {runError}</div>}
      </form>

      <SavedScenariosView form={form} result={resultFingerprint === encodeScenario(form) ? result : null} onShare={(scenario) => share(scenario, false)} onOpen={(item: SavedScenario) => { setForm(item.form); setResult(null); setResultFingerprint(null); setRunError(null); setSubmitted(false); window.history.replaceState(null, '', window.location.pathname + window.location.search) }} />

      {result && <ResultsView result={result} form={form} />}
      </>}
    </main>
  )
}

type SettingsBlockProps = { form: ScenarioFormState; errors: ScenarioFormErrors; submitted: boolean; update: (patch: Partial<ScenarioFormState>) => void }

function StopPresetControls({ elevatorIndex, floorCount, undergroundFloorCount, initialElevatorFloor, setPreviewStops }: { elevatorIndex: number; floorCount: number; undergroundFloorCount: number; initialElevatorFloor: number; setPreviewStops: Dispatch<SetStateAction<readonly (readonly number[])[]>> }) {
  const underground = Array.from({ length: undergroundFloorCount }, (_, index) => -(index + 1))
  const allFloors = [...underground, ...Array.from({ length: floorCount }, (_, index) => index + 1)].sort((a, b) => a - b)
  const alternatingFloors = Array.from({ length: floorCount }, (_, index) => index + 1).filter((floor) => floor % 2 === 1)
  return <div className="stop-presets" aria-label={`Быстрое заполнение остановок лифта ${elevatorIndex + 1}`}><div className="stop-preset-row"><span>Быстрый выбор:</span><button type="button" className="secondary-button" onClick={() => setPreviewStops((current) => current.map((floors, index) => index === elevatorIndex ? allFloors : floors))}>Все этажи</button><button type="button" className="secondary-button" onClick={() => setPreviewStops((current) => current.map((floors, index) => index === elevatorIndex ? [...new Set([...underground, ...alternatingFloors, 1, initialElevatorFloor])].sort((a, b) => a - b) : floors))}>Через этаж от 1-го</button></div></div>
}

function EmployeeFloorColumns({ form, update }: { form: ScenarioFormState; update: (patch: Partial<ScenarioFormState>) => void }) {
  const columns = Array.from({ length: Math.ceil(form.floors.length / 5) }, (_, index) => form.floors.slice(index * 5, index * 5 + 5))
  return <div className="floor-columns" aria-label="Численность сотрудников по этажам">{columns.map((floors, columnIndex) => <div className="floor-column" key={columnIndex}><strong className="floor-column-title">Этажи {floors[0].floor}–{floors[floors.length - 1].floor}</strong>{floors.map((floorValue) => <label className="floor-count-row" key={floorValue.floor}><span>{floorValue.floor} этаж</span><div className="input-with-suffix"><EditableNumberInput ariaLabel={`Сотрудники на этаже ${floorValue.floor}`} min={0} step={1} value={floorValue.employees} invalid={!Number.isSafeInteger(floorValue.employees) || floorValue.employees < 0 || floorValue.employees > 10000} disabled={form.distributionMode === 'equal'} onValueChange={(employees) => update({ floors: form.floors.map((floor) => floor.floor === floorValue.floor ? { ...floor, employees } : floor) })} /><em>чел.</em></div></label>)}</div>)}</div>
}

function MeetingSettings({ form, errors, submitted, update }: SettingsBlockProps) {
  return <div className="grouped-settings"><div className="field-grid two"><NumberField label="Среднее число встреч на сотрудника" value={form.meanMeetingsPerEmployee} min={0} max={10} step={0.1} error={submitted ? errors.meanMeetingsPerEmployee : undefined} onChange={(meanMeetingsPerEmployee) => update({ meanMeetingsPerEmployee })} hint="Можно указать дробное значение: 2,5 означает в среднем две–три встречи за день." /><NumberField label="Максимальная доля участников одновременно" suffix="%" value={form.maxMeetingConcurrentShare * 100} min={0} max={100} error={submitted ? errors.maxMeetingConcurrentShare : undefined} onChange={(value) => update({ maxMeetingConcurrentShare: value / 100 })} hint="Выбираются только свободные в это время сотрудники." /></div><details className="nested-disclosure"><summary>Продолжительность встреч</summary><DistributionEditor legend="Распределение по длительности" labels={['30 минут','45 минут','60 минут']} values={form.meetingDurationShares} error={errors.meetingDurationShares} onChange={(meetingDurationShares) => update({ meetingDurationShares: meetingDurationShares as [number,number,number] })} /></details><details className="nested-disclosure"><summary>Доступность переговорных по часам</summary><p className="hint">Вероятность применяется независимо к каждой встрече. При значении 80% и большом количестве встреч переговорная будет найдена примерно в 80% случаев.</p><button className="secondary-button" type="button" onClick={() => update({ meetingRoomFoundSharesByHour: Array(24).fill(0.8) })}>Установить 80% для всех часов</button><div className="field-grid two">{Array.from({ length: Math.max(0, Math.ceil(form.meetingEnd / 60) - Math.floor(form.meetingStart / 60)) }, (_, index) => Math.floor(form.meetingStart / 60) + index).filter((hour) => hour >= 0 && hour < 24).map((hour) => <NumberField key={hour} label={`${String(hour).padStart(2,'0')}:00–${String(hour + 1).padStart(2,'0')}:00`} suffix="%" value={form.meetingRoomFoundSharesByHour[hour] * 100} min={0} max={100} error={submitted && (form.meetingRoomFoundSharesByHour[hour] < 0 || form.meetingRoomFoundSharesByHour[hour] > 1) ? 'Укажите значение от 0 до 100%' : undefined} onChange={(value) => update({ meetingRoomFoundSharesByHour: form.meetingRoomFoundSharesByHour.map((item,index) => index === hour ? value / 100 : item) })} />)}</div></details><p className="hint">Если переговорная не найдена, половина сотрудников сразу возвращается на рабочий этаж, а остальные остаются на достигнутом этаже до окончания встречи и затем возвращаются.</p></div>
}

function LunchSettings({ form, errors, submitted, update }: SettingsBlockProps) {
  return <div className="grouped-settings"><div className="field-grid three"><NumberField label="Время до начала возвращения" suffix="мин." value={form.lunchDurationMinutes} min={15} max={60} error={submitted ? errors.lunchDurationMinutes : undefined} onChange={(lunchDurationMinutes) => update({ lunchDurationMinutes })} hint="Интервал от начала пути в столовую до начала обратного пути." /><NumberField label="Разброс времени возвращения" suffix="± мин." value={form.lunchDurationJitterMinutes} min={0} max={15} step={0.1} error={submitted ? errors.lunchDurationJitterMinutes : undefined} onChange={(lunchDurationJitterMinutes) => update({ lunchDurationJitterMinutes })} hint="Для каждого сотрудника интервал случайно увеличивается или уменьшается. Итог — от 15 до 60 минут." /><NumberField label="Разброс выхода вокруг пика" suffix="мин." value={form.lunchWaveMinutes} min={5} max={120} step={0.1} error={submitted ? errors.lunchWaveMinutes : undefined} onChange={(lunchWaveMinutes) => update({ lunchWaveMinutes })} hint="Чем меньше значение, тем плотнее сотрудники выходят около пикового времени." /></div><p className="hint">Начало и возвращение моделируются с точностью до секунды. Интервалы на графике используются только для отображения.</p></div>
}

function StairSettings({ form, errors, submitted, update }: SettingsBlockProps) {
  return <div className="grouped-settings">
    <label className="check-line"><input type="checkbox" checked={form.stairsConvenient} onChange={(event) => update({ stairsConvenient: event.target.checked })} />Лестницей удобно пользоваться</label>
    <p className="hint">Для обычных перемещений вероятности удобной и неудобной лестницы задаются отдельно. При перегрузе на обеде значения для неудобной лестницы рассчитываются с помощью коэффициента.</p>
    <div className="field-grid two"><NumberField label="Максимальный обычный путь" suffix="эт." value={form.maxVoluntaryStairFloors} min={1} max={6} error={submitted ? errors.maxVoluntaryStairFloors : undefined} onChange={(maxVoluntaryStairFloors) => update({ maxVoluntaryStairFloors })} /><NumberField label="Коэффициент для неудобной лестницы" value={form.inconvenientStairFactor} min={0} max={1} step={0.1} error={submitted ? errors.inconvenientStairFactor : undefined} onChange={(inconvenientStairFactor) => update({ inconvenientStairFactor })} hint="Применяется только при перегрузе на обеде. Значение 0,5 уменьшает вероятности вдвое." /></div>
    <details className="nested-disclosure"><summary>Обычные дневные перемещения</summary><div className="distribution-action"><button className="secondary-button" type="button" onClick={() => update({ convenientStairProbabilities: Array(6).fill(0), inconvenientStairProbabilities: Array(6).fill(0) })}>Установить 0% для обычных перемещений</button><button className="secondary-button" type="button" onClick={() => update({ convenientStairProbabilities: [...DEFAULT_STAIR_CHOICE_SETTINGS.convenientProbabilities], inconvenientStairProbabilities: [...DEFAULT_STAIR_CHOICE_SETTINGS.inconvenientProbabilities] })}>Стандартные значения</button><p className="hint">Зануление отключает добровольный выбор лестницы. Обязательный пеший участок из-за этажей без остановки лифта сохраняется.</p></div><DistributionEditor legend="Удобная лестница" labels={['1 этаж','2 этажа','3 этажа','4 этажа','5 этажей','6 этажей']} values={form.convenientStairProbabilities} disabledAfter={form.maxVoluntaryStairFloors} error={errors.convenientStairProbabilities} requireTotal={false} onChange={(convenientStairProbabilities) => update({ convenientStairProbabilities })} /><DistributionEditor legend="Неудобная лестница" labels={['1 этаж','2 этажа','3 этажа','4 этажа','5 этажей','6 этажей']} values={form.inconvenientStairProbabilities} disabledAfter={form.maxVoluntaryStairFloors} error={errors.inconvenientStairProbabilities} requireTotal={false} onChange={(inconvenientStairProbabilities) => update({ inconvenientStairProbabilities })} /></details>
    <details className="nested-disclosure"><summary>Спуск на обед при перегрузе</summary><label className="check-line"><input type="checkbox" checked={form.lunchOverloadStairsEnabled} onChange={(event) => update({ lunchOverloadStairsEnabled: event.target.checked })} />Разрешить спуск по лестнице при перегрузе</label><p className="hint">Очередь считается перегруженной, если перед сотрудником ждут не менее чем 1,5 вместимости одного лифта. Решение принимается один раз — только по пути в столовую и только при движении вниз.</p><div className="distribution-action"><button className="secondary-button" type="button" onClick={() => update({ lunchOverloadStairProbabilities: Array(7).fill(0) })}>Установить 0% при обеденном перегрузе</button><button className="secondary-button" type="button" onClick={() => update({ lunchOverloadStairProbabilities: [...DEFAULT_LUNCH_OVERLOAD_STAIR_SETTINGS.probabilities] })}>Стандартные значения</button></div><DistributionEditor legend="Вероятность для удобной лестницы" labels={['1 этаж','2 этажа','3 этажа','4 этажа','5 этажей','6 этажей','7+ этажей']} values={form.lunchOverloadStairProbabilities} error={errors.lunchOverloadStairProbabilities} requireTotal={false} minPercent={5} onChange={(lunchOverloadStairProbabilities) => update({ lunchOverloadStairProbabilities })} /><p className="hint">Для неудобной лестницы значения умножаются на {form.inconvenientStairFactor}. Например, 5% при коэффициенте 0,5 превращаются в 2,5%.</p></details>
    <details className="nested-disclosure"><summary>Кнопки вызова</summary><p className="hint">Базовая модель использует отдельные кнопки «вверх» и «вниз».</p></details>
  </div>
}

function ReportSettings({ form, errors, update }: Omit<SettingsBlockProps, 'submitted'>) {
  const levelNames = ['Первый уровень', 'Второй уровень', 'Третий уровень']
  return <details className="section-card top-disclosure"><summary className="section-heading"><span className="section-number">05</span><span><strong>Группировка результатов по времени суток</strong><small>Границы утра, дня и вечера для итогового отчёта</small></span></summary><p className="section-intro">Эти настройки не влияют на движение сотрудников и работу лифтов. Они нужны только для группировки результатов.</p><details className="disclosure" open><summary><span>Границы периодов в результатах</span>{errors.reportPeriods && <b className="error-badge">Есть ошибка</b>}<small>{formatTime(form.reportMorningStart)}–{formatTime(form.reportEveningEnd)}</small></summary><div className="details-body time-grid"><TimeField label="Начало утреннего периода" value={form.reportMorningStart} invalid={Boolean(errors.reportPeriods)} onChange={(reportMorningStart) => update({ reportMorningStart })} /><TimeField label="Начало дневного периода" value={form.reportDayStart} invalid={Boolean(errors.reportPeriods)} onChange={(reportDayStart) => update({ reportDayStart })} /><TimeField label="Начало вечернего периода" value={form.reportEveningStart} invalid={Boolean(errors.reportPeriods)} onChange={(reportEveningStart) => update({ reportEveningStart })} /><TimeField label="Окончание вечернего периода" value={form.reportEveningEnd} invalid={Boolean(errors.reportPeriods)} onChange={(reportEveningEnd) => update({ reportEveningEnd })} /></div>{errors.reportPeriods && <p className="field-error">{errors.reportPeriods}</p>}</details><details className="disclosure"><summary><span>Уровни долгого ожидания лифта</span><small>Более {form.longWaitThresholds.join(', ')} сек.</small></summary><div className="details-body"><p className="hint">В результатах будет показана доля поездок, в которых сотрудник ждал лифт дольше каждого указанного значения.</p><div className="field-grid three">{form.longWaitThresholds.map((value,index) => <NumberField key={index} label={levelNames[index]} suffix="сек." value={value} min={1} max={36000} onChange={(next) => update({ longWaitThresholds: form.longWaitThresholds.map((item,current) => current === index ? next : item) as [number,number,number] })} />)}</div>{errors.longWaitThresholds && <p className="field-error">{errors.longWaitThresholds}</p>}</div></details></details>
}

function ParkingSettings({ form, errors, submitted, servedFloors, update }: SettingsBlockProps & { servedFloors: readonly number[] }) {
  const hasErrors = Boolean(errors.parking) || Object.keys(errors).some((key) => key.startsWith('parking-'))
  return <details className="disclosure"><summary><span>Парковка лифтов</span>{hasErrors && <b className="error-badge">Есть ошибка</b>}<small>{form.parkingByElevator.filter((item) => item.enabled).length === 0 ? 'выключена' : `включена для ${form.parkingByElevator.filter((item) => item.enabled).length}`}</small></summary><div className="details-body parking-list"><p className="hint">Если вызовов нет, лифт после заданной паузы возвращается на указанный этаж. Вызовы пассажиров всегда имеют приоритет.</p>{form.parkingByElevator.map((parking,elevatorIndex) => { const parkingError = errors[`parking-${elevatorIndex}`]; return <div className={`parking-card ${parkingError ? 'has-error' : ''}`} key={elevatorIndex}><div className="parking-card-head"><strong>Лифт {elevatorIndex+1}</strong><label className="check-line"><input type="checkbox" checked={parking.enabled} onChange={(event) => update({ parkingByElevator: form.parkingByElevator.map((item,index) => index === elevatorIndex ? { ...item, enabled: event.target.checked } : item) })} />Парковать по расписанию</label></div>{parking.enabled && <><NumberField label="Пауза без вызовов" suffix="сек." value={parking.timeoutSeconds} min={0} max={3600} onChange={(timeoutSeconds) => update({ parkingByElevator: form.parkingByElevator.map((item,index) => index === elevatorIndex ? { ...item, timeoutSeconds } : item) })} />{parking.intervals.map((interval,intervalIndex) => <div className="parking-interval" key={intervalIndex}><TimeField label="Начало" value={interval.startMinute} invalid={Boolean(parkingError)} onChange={(startMinute) => updateParkingInterval(elevatorIndex, intervalIndex, { startMinute }, form, update)} /><TimeField label="Окончание" value={interval.endMinute} invalid={Boolean(parkingError)} onChange={(endMinute) => updateParkingInterval(elevatorIndex, intervalIndex, { endMinute }, form, update)} /><label className="field"><span>Этаж</span><select value={interval.floor} onChange={(event) => updateParkingInterval(elevatorIndex, intervalIndex, { floor: Number(event.target.value) }, form, update)}>{form.servedFloorsByElevator[elevatorIndex].map((floor) => <option key={floor} value={floor}>{floor}</option>)}</select></label><button className="remove-button" type="button" onClick={() => update({ parkingByElevator: form.parkingByElevator.map((item,index) => index === elevatorIndex ? { ...item, intervals: item.intervals.filter((_,current) => current !== intervalIndex) } : item) })}>Удалить</button></div>)}<button className="secondary-button" type="button" onClick={() => addParkingInterval(elevatorIndex, form, update)}>+ Добавить период</button>{submitted && parkingError && <p className="field-error">{parkingError}</p>}</>}</div>})}</div></details>
}

function dispatchStrategyCopy(strategy: ScenarioFormState['dispatchStrategy']): { title: string; description: string; effect: string } {
  if (strategy === 'global-fifo') return { title: 'Приоритет времени вызова', description: 'Вызовы обслуживаются в порядке поступления (FIFO), начиная с самого раннего. Для него выбирается ближайшая свободная кабина.', effect: 'Снижает разницу в ожидании между этажами, но может увеличить пустой пробег.' }
  if (strategy === 'hybrid') return { title: 'Баланс скорости и справедливости', description: 'Обычно лифт направляется к ближайшему вызову. Если вызов ждёт 120 секунд, он получает приоритет по времени поступления. В лифте резервируются места для пассажиров из ранее закреплённой очереди.', effect: 'Защищает долго ожидающие этажи, сохраняя короткую подачу при обычной нагрузке.' }
  return { title: 'Приоритет короткой подачи', description: 'Свободный лифт отправляется к ближайшему этажу; время вызова учитывается при равной дистанции.', effect: 'Сокращает пустой пробег, но при пике нижние этажи могут ждать дольше.' }
}

function plural(value: number, one: string, few: string, many: string): string {
  const integer = Math.abs(Math.trunc(value))
  if (integer % 10 === 1 && integer % 100 !== 11) return one
  if (integer % 10 >= 2 && integer % 10 <= 4 && (integer % 100 < 12 || integer % 100 > 14)) return few
  return many
}

function NumberField({ label, suffix, value, min, max, step = 1, error, hint, onChange }: { label: string; suffix?: string; value: number; min: number; max: number; step?: number; error?: string; hint?: string; onChange: (value: number) => void }) {
  const id = useId(); const descriptionId = `${id}-description`
  const rangeError = !Number.isFinite(value) || value < min || value > max ? `Допустимое значение: от ${String(min).replace('.', ',')} до ${String(max).replace('.', ',')}` : undefined
  const stepError = !rangeError && Math.abs((value - min) / step - Math.round((value - min) / step)) > 1e-9 ? `Используйте шаг ${String(step).replace('.', ',')}` : undefined
  const visibleError = error ?? rangeError ?? stepError
  return <label className="field" htmlFor={id}><span>{label}</span><div className="input-with-suffix"><EditableNumberInput id={id} min={min} max={max} step={step} value={value} invalid={Boolean(visibleError)} describedBy={hint || visibleError ? descriptionId : undefined} onValueChange={onChange} />{suffix && <em>{suffix}</em>}</div>{hint && <small id={descriptionId} className="field-hint">{hint}</small>}{visibleError && <small id={descriptionId} className="field-error" role="alert">{visibleError}</small>}</label>
}
function TimeField({ label, value, invalid = false, onChange }: { label: string; value: number; invalid?: boolean; onChange: (value: number) => void }) { const id = useId(); return <label className="field" htmlFor={id}><span>{label}</span><input id={id} type="time" value={formatTime(value)} aria-invalid={invalid} onChange={(event) => onChange(parseTime(event.target.value))} /></label> }
function DistributionEditor({ legend, labels, values, onChange, error, disabledAfter, requireTotal = true, minPercent = 0 }: { legend: string; labels: readonly string[]; values: readonly number[]; onChange: (values: number[]) => void; error?: string; disabledAfter?: number; requireTotal?: boolean; minPercent?: number }) {
  const total = values.reduce((sum, value) => sum + value, 0) * 100
  return <fieldset className="compact-fieldset"><legend>{legend}</legend><div className="distribution-grid">{labels.map((label,index) => { const percent = Number((values[index] * 100).toFixed(10)); const invalid = !Number.isFinite(percent) || (percent !== 0 && percent < minPercent) || percent > 100; return <label key={label}><span>{label}</span><div className="input-with-suffix"><EditableNumberInput ariaLabel={`${legend}: ${label}`} min={0} max={100} step={0.1} value={percent} invalid={invalid} disabled={disabledAfter !== undefined && index >= disabledAfter} onValueChange={(nextPercent) => onChange(values.map((value,current) => current === index ? nextPercent / 100 : value))} /><em>%</em></div>{disabledAfter !== undefined && index >= disabledAfter && <small>не используется</small>}</label> })}</div>{requireTotal && <div className={`distribution-total ${error ? 'has-error' : ''}`} aria-live="polite">Сумма: {Number(total.toFixed(1))}%</div>}{error && <p className="field-error">{error}</p>}</fieldset>
}
function EditableNumberInput({ id, ariaLabel, value, min, max, step, invalid = false, disabled = false, describedBy, onValueChange }: { id?: string; ariaLabel?: string; value: number; min?: number; max?: number; step?: number; invalid?: boolean; disabled?: boolean; describedBy?: string; onValueChange: (value: number) => void }) {
  const displayValue = Number.isFinite(value) ? String(Number(value.toFixed(10))) : String(value)
  const [draft, setDraft] = useState(displayValue)
  const focused = useRef(false)
  useEffect(() => { if (!focused.current) setDraft(displayValue) }, [displayValue])
  return <input id={id} aria-label={ariaLabel} type="number" min={min} max={max} step={step} value={draft} aria-invalid={invalid} aria-describedby={describedBy} disabled={disabled} onFocus={() => { focused.current = true }} onChange={(event) => { const next = event.target.value; setDraft(next); if (next !== '') { const parsed = Number(next); if (Number.isFinite(parsed)) onValueChange(parsed) } }} onBlur={() => { focused.current = false; if (draft.trim() === '') { setDraft('0'); onValueChange(0); return } const parsed = Number(draft); if (Number.isFinite(parsed)) { setDraft(String(Number(parsed.toFixed(10)))); onValueChange(parsed) } }} />
}
function formatTime(minutes: number): string { return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}` }
function meetingAvailabilitySummary(form: ScenarioFormState): string {
  const start = Math.max(0, Math.floor(form.meetingStart / 60))
  const end = Math.min(24, Math.ceil(form.meetingEnd / 60))
  const values = form.meetingRoomFoundSharesByHour.slice(start, end)
  if (values.length === 0) return 'проверьте период'
  const low = Math.round(Math.min(...values) * 100)
  const high = Math.round(Math.max(...values) * 100)
  return low === high ? `${low}%` : `${low}–${high}%`
}
function parseTime(value: string): number { const [hours, minutes] = value.split(':').map(Number); return hours * 60 + minutes }
async function copyText(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(value)
  const textarea = document.createElement('textarea')
  textarea.value = value
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  document.body.append(textarea)
  textarea.select()
  const copied = document.execCommand('copy')
  textarea.remove()
  if (!copied) throw new Error('Копирование недоступно')
}
function updateParkingInterval(elevatorIndex: number, intervalIndex: number, patch: { startMinute?: number; endMinute?: number; floor?: number }, form: ScenarioFormState, update: (patch: Partial<ScenarioFormState>) => void): void {
  update({ parkingByElevator: form.parkingByElevator.map((parking,index) => index === elevatorIndex ? { ...parking, intervals: parking.intervals.map((interval,current) => current === intervalIndex ? { ...interval, ...patch } : interval) } : parking) })
}
function addParkingInterval(elevatorIndex: number, form: ScenarioFormState, update: (patch: Partial<ScenarioFormState>) => void): void {
  const intervals = form.parkingByElevator[elevatorIndex].intervals
  const lastEnd = intervals.reduce((latest, interval) => Math.max(latest, interval.endMinute), 0)
  const startMinute = intervals.length === 0 ? 7 * 60 : lastEnd < 24 * 60 - 60 ? lastEnd : 0
  const endMinute = intervals.length === 0 ? 11 * 60 : Math.min(startMinute + 60, 24 * 60)
  update({ parkingByElevator: form.parkingByElevator.map((parking,index) => index === elevatorIndex ? { ...parking, intervals: [...parking.intervals, { startMinute, endMinute, floor: 1 }] } : parking) })
}
