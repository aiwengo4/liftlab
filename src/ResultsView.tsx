import { useEffect, useRef, useState } from 'react'
import type { BrowserSimulationResult } from './browserResult'
type FullDayResult = BrowserSimulationResult
import type { MetricSlice, TimeStatistics } from './engine/metrics'
import { dispatchStrategyLabel, type ScenarioFormState } from './scenarioForm'

type Period = 'wholeDay' | 'morning' | 'day' | 'evening'
export interface HistogramBin { from: number; to: number; count: number }
export interface MeetingRoomSummaryRow { hour: number | null; planned: number; found: number; returnedImmediately: number; stayedUntilEnd: number; notCompleted: number }

type MeetingSummaryInput = { plannedStartMinute: number; decisionKinds?: readonly string[]; decisions?: readonly { kind: string }[] }
export function summarizeMeetingRooms(meetings: readonly MeetingSummaryInput[]): MeetingRoomSummaryRow[] {
  const total = row(null)
  const byHour = new Map<number, MeetingRoomSummaryRow>()
  for (const meeting of meetings) {
    const hour = Math.floor(meeting.plannedStartMinute / 60)
    const hourly = byHour.get(hour) ?? row(hour)
    addMeeting(total, meeting)
    addMeeting(hourly, meeting)
    byHour.set(hour, hourly)
  }
  return [total, ...[...byHour.values()].sort((a, b) => a.hour! - b.hour!)]
}

export function buildHistogram(values: readonly number[], target = 10): HistogramBin[] {
  if (values.length === 0) return []
  const maximum = Math.max(...values)
  const width = Math.max(1, Math.ceil(Math.max(1, maximum) / target))
  const bins = Array.from({ length: Math.max(1, Math.floor(maximum / width) + 1) }, (_, index) => ({ from: index * width, to: (index + 1) * width, count: 0 }))
  values.forEach((value) => { bins[Math.min(bins.length - 1, Math.floor(value / width))].count += 1 })
  return bins
}

export function ResultsView({ result, form }: { result: BrowserSimulationResult; form: ScenarioFormState }) {
  const [period, setPeriod] = useState<Period>('wholeDay')
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => { heading.current?.focus(); heading.current?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' }) }, [result])
  const periods: { key: Period; label: string; time?: string }[] = [
    { key: 'wholeDay', label: 'Весь день' },
    { key: 'morning', label: 'Утро', time: clock(form.reportMorningStart) + '–' + clock(form.reportDayStart) },
    { key: 'day', label: 'День', time: clock(form.reportDayStart) + '–' + clock(form.reportEveningStart) },
    { key: 'evening', label: 'Вечер', time: clock(form.reportEveningStart) + '–' + clock(form.reportEveningEnd) },
  ]
  const slice = result.metrics[period]
  const hours = result.metrics.hours.filter((hour) => hour.routeCount > 0)
  const group = result.operationalMetrics.group
  const meetingRooms = summarizeMeetingRooms(result.meetings)
  return <section className="results" aria-labelledby="results-title">
    <div className="section-heading"><span className="section-number">✓</span><div><h2 id="results-title" ref={heading} tabIndex={-1}>Результаты сценария #{form.seed}</h2><p>{result.metrics.counters.completedRoutes} завершённых маршрутов · алгоритм «{dispatchStrategyLabel(form.dispatchStrategy)}». Тот же seed сохраняет поток сотрудников.</p></div></div>
    <div className="metric-grid result-summary"><Metric label="Среднее ожидание" value={duration(result.metrics.wholeDay.waiting.meanSeconds)} /><Metric label="P90 ожидания" value={duration(result.metrics.wholeDay.waiting.p90Seconds)} /><Metric label="Средний полный маршрут" value={duration(result.metrics.wholeDay.total.meanSeconds)} /><Metric label="Максимальная очередь" value={result.operationalMetrics.queue.maximumWaitingInBuilding + ' чел.'} /></div>

    <section className="result-block"><header><h3>Время маршрутов</h3><p>Маршрут относится к периоду по фактическому времени начала.</p></header>
      <div className="period-tabs" role="group" aria-label="Период отчёта">{periods.map((item) => <button type="button" key={item.key} aria-pressed={period === item.key} onClick={() => setPeriod(item.key)}><strong>{item.label}</strong>{item.time && <small>{item.time}</small>}</button>)}</div>
      <Statistics slice={slice} />
      <p className="result-note">Ожидание и поездка — только маршруты с лифтом; полный маршрут — все, включая лестницу. «Весь день» может включать время вне трёх периодов.</p>
    </section>

    <section className="result-block"><header><h3>Распределения времени</h3><p>Гистограммы меняются вместе с выбранным периодом.</p></header><div className="histogram-grid"><Histogram title="Ожидание лифта" values={slice.waitingDistributionSeconds} /><Histogram title="Полный маршрут" values={slice.totalDistributionSeconds} /></div></section>

    <details className="result-disclosure"><summary><span>По часам</span><small>{hours.length} часов с маршрутами</small></summary><div className="result-details"><p className="table-swipe">На узком экране проведите таблицу в сторону.</p><TableScroll><table className="result-table"><caption className="sr-only">Почасовые показатели</caption><thead><tr><th>Час</th><th>Маршруты</th><th>Ждали: сред.</th><th>Ждали: медиана</th><th>Ждали: P90</th><th>Ехали: сред.</th><th>Ехали: медиана</th><th>Ехали: P90</th><th>Полное: сред.</th><th>Полное: медиана</th><th>Полное: P90</th></tr></thead><tbody>{hours.map((hour) => <tr key={hour.hour}><th scope="row">{String(hour.hour).padStart(2,'0')}:00</th><td>{hour.routeCount}</td><Cells stats={hour.waiting} /><Cells stats={hour.riding} /><Cells stats={hour.total} /></tr>)}</tbody></table></TableScroll></div></details>

    <details className="result-disclosure"><summary><span>Долгое ожидание</span><small>строго дольше порога</small></summary><div className="result-details long-wait-list">{slice.longWaits.map((item) => <div key={item.thresholdSeconds}><span>Дольше {duration(item.thresholdSeconds)}</span><strong>{item.count} · {percent(item.share)}</strong></div>)}</div></details>

    <details className="result-disclosure"><summary><span>Лестница</span><small>{result.metrics.counters.employeesUsingVoluntaryStairs} сотрудников выбирали добровольно</small></summary><div className="result-details metric-grid stair-grid"><Metric label="Сотрудники, выбравшие лестницу" value={result.metrics.counters.employeesUsingVoluntaryStairs + ' чел.'} note={percent(result.metrics.counters.voluntaryStairsEmployeeShare) + ' сотрудников с маршрутами'} /><Metric label="Лифт + обязательная лестница" value={result.metrics.counters.combinedRoutes + ' маршр.'} /><Metric label="Завершённые маршруты" value={result.metrics.counters.completedRoutes + ' маршр.'} /></div></details>

    <details className="result-disclosure"><summary><span>Работа лифтов за весь день</span><small>{number(group.resource.floorsTravelled)} этажей пройдено</small></summary><div className="result-details">
      <div className="metric-grid operations-grid"><Metric label="Пройдено этажей" value={number(group.resource.floorsTravelled)} note={'пустыми: ' + number(group.resource.emptyFloorsTravelled)} /><Metric label="Остановки" value={String(group.resource.stops)} note={'циклов дверей: ' + group.resource.doorOpeningCycles} /><Metric label="Перевезено пассажиров" value={String(group.resource.transportedPassengers)} note={'на остановку: ' + number(group.resource.passengersPerStop)} /><Metric label="Максимальная загрузка" value={percent(group.load.maximumCapacityShare)} note={'средняя: ' + percent(group.load.averageCapacityShare)} /></div>
      <Utilization result={result} />
      <TableScroll><table className="result-table"><caption>По отдельным лифтам</caption><thead><tr><th>Лифт</th><th>Этажи</th><th>Пустыми</th><th>Остановки</th><th>Пассажиры</th><th>Сред. загрузка</th><th>Макс. загрузка</th></tr></thead><tbody>{result.operationalMetrics.elevators.map((item) => <tr key={item.elevatorId}><th scope="row">№ {item.elevatorId}</th><td>{number(item.resource.floorsTravelled)}</td><td>{number(item.resource.emptyFloorsTravelled)}</td><td>{item.resource.stops}</td><td>{item.resource.transportedPassengers}</td><td>{percent(item.load.averageCapacityShare)}</td><td>{percent(item.load.maximumCapacityShare)}</td></tr>)}</tbody></table></TableScroll>
    </div></details>

    <details className="result-disclosure"><summary><span>Дополнительно: встречи</span><small>{meetingRooms[0].planned === 0 ? 'встречи не запланированы' : `${meetingRooms[0].planned} встреч`}</small></summary><div className="result-details"><p className="result-note">Служебная детализация генерации дневного потока. На показатели лифтов влияют перемещения сотрудников, а не занятость конкретных комнат.</p>{meetingRooms[0].planned > 0 && <><div className="metric-grid"><Metric label="Запланировано" value={String(meetingRooms[0].planned)} /><Metric label="Нашли переговорную" value={countShare(meetingRooms[0].found, meetingRooms[0].planned)} /><Metric label="Не нашли — сразу вернулись" value={countShare(meetingRooms[0].returnedImmediately, meetingRooms[0].planned)} /><Metric label="Не нашли — остались до конца" value={countShare(meetingRooms[0].stayedUntilEnd, meetingRooms[0].planned)} /></div>{meetingRooms[0].notCompleted > 0 && <p className="warning">Не завершено из-за опоздания или ухода: {meetingRooms[0].notCompleted}</p>}<details className="nested-disclosure"><summary>По часам</summary><p className="table-swipe">На узком экране проведите таблицу в сторону.</p><TableScroll><table className="result-table"><caption className="sr-only">Результаты моделирования встреч по часам</caption><thead><tr><th>Час</th><th>Запланировано</th><th>Нашли</th><th>Сразу вернулись</th><th>Остались до конца</th><th>Не завершено</th></tr></thead><tbody>{meetingRooms.slice(1).map((item) => <tr key={item.hour}><th scope="row">{String(item.hour).padStart(2,'0')}:00–{String(item.hour! + 1).padStart(2,'0')}:00</th><td>{item.planned}</td><td>{countShare(item.found, item.planned)}</td><td>{countShare(item.returnedImmediately, item.planned)}</td><td>{countShare(item.stayedUntilEnd, item.planned)}</td><td>{item.notCompleted}</td></tr>)}</tbody></table></TableScroll></details></>}</div></details>
  </section>
}

function row(hour: number | null): MeetingRoomSummaryRow { return { hour, planned: 0, found: 0, returnedImmediately: 0, stayedUntilEnd: 0, notCompleted: 0 } }
function addMeeting(target: MeetingRoomSummaryRow, meeting: MeetingSummaryInput): void {
  target.planned += 1
  const kinds = new Set(meeting.decisionKinds ?? meeting.decisions?.map((decision) => decision.kind) ?? [])
  if (kinds.has('room-acquired')) target.found += 1
  else if (kinds.has('fallback-origin')) target.returnedImmediately += 1
  else if (kinds.has('fallback-stay')) target.stayedUntilEnd += 1
  else target.notCompleted += 1
}

function Statistics({ slice }: { slice: MetricSlice }) { const rows: [string,TimeStatistics][]=[['Ждал лифт',slice.waiting],['Ехал в лифте',slice.riding],['Полный маршрут',slice.total]]; return <TableScroll><table className="result-table"><caption className="sr-only">Статистика времени</caption><thead><tr><th>Показатель</th><th>Среднее</th><th>Медиана</th><th>P75</th><th>P90</th><th>P95</th><th>Наблюдения</th></tr></thead><tbody>{rows.map(([label,item]) => <tr key={label}><th scope="row">{label}</th><td>{duration(item.meanSeconds)}</td><td>{duration(item.medianSeconds)}</td><td>{duration(item.p75Seconds)}</td><td>{duration(item.p90Seconds)}</td><td>{duration(item.p95Seconds)}</td><td>{item.sampleSize}</td></tr>)}</tbody></table></TableScroll> }
function Cells({ stats }: { stats: TimeStatistics }) { return <><td>{duration(stats.meanSeconds)}</td><td>{duration(stats.medianSeconds)}</td><td>{duration(stats.p90Seconds)}</td></> }
function Histogram({ title, values }: { title:string; values:readonly number[] }) { const bins=buildHistogram(values); const max=Math.max(1,...bins.map((item)=>item.count)); return <figure className="histogram"><figcaption><strong>{title}</strong><span>{values.length} наблюдений</span></figcaption>{bins.length===0?<p>Нет маршрутов</p>:<><div className="histogram-bars" aria-hidden="true">{bins.map((item,index)=><div className="histogram-column" key={index}><b>{item.count}</b><i style={{height:Math.max(3,item.count/max*100)+'%'}}/><small>{histogramLabel(item)}</small></div>)}</div><ol className="sr-only">{bins.map((item,index)=><li key={index}>{histogramLabel(item)}: {item.count}</li>)}</ol></>}</figure> }
function Utilization({ result }: { result:FullDayResult }) { const item=result.operationalMetrics.group.timeUse; const entries=[['use-passenger','С пассажирами',item.passengerMovementShare],['use-empty','Пустой пробег',item.emptyMovementShare],['use-service','Остановки',item.stopServiceShare],['use-idle','Простой',item.idleShare]] as const; return <div className="utilization"><div className="utilization-bar" aria-hidden="true">{entries.map(([css,,share])=><i key={css} className={css} style={{width:share*100+'%'}} />)}</div><div className="utilization-legend">{entries.map(([css,label,share])=><span key={css}><i className={css}/>{label} {percent(share)}</span>)}</div></div> }
function TableScroll({children}:{children:React.ReactNode}) { return <div className="result-table-scroll" tabIndex={0} role="region" aria-label="Таблица результатов">{children}</div> }
function Metric({label,value,note}:{label:string;value:string;note?:string}) { return <div className="metric"><span>{label}</span><strong>{value}</strong>{note&&<small>{note}</small>}</div> }
export function duration(value:number|null):string { if(value===null)return '—'; const rounded=Math.round(value); if(rounded<60)return rounded+' с'; const m=Math.floor(rounded/60),s=rounded%60; return m+' мин'+(s?' '+s+' с':'') }
export function histogramLabel(item: HistogramBin): string { return item.from+'–<'+item.to+' с' }
function percent(value:number|null):string { return value===null?'—':(value*100).toFixed(1)+'%' }
function countShare(count: number, total: number): string { return `${count} · ${total === 0 ? '—' : (count / total * 100).toFixed(1) + '%'}` }
function number(value:number|null):string { return value===null?'—':Number(value.toFixed(1)).toString() }
function clock(value:number):string { return String(Math.floor(value/60)).padStart(2,'0')+':'+String(value%60).padStart(2,'0') }
