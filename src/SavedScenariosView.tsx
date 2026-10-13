import { useEffect, useRef, useState } from 'react'
import type { BrowserSimulationResult } from './browserResult'
import { dispatchStrategyLabel, type ScenarioFormState } from './scenarioForm'
import { compareMetric, comparisonCompatibility, loadSavedScenarios, makeSavedScenario, MAX_SAVED_SCENARIOS, persistSavedScenarios, type ComparisonTimeSlice, type SavedScenario, type ScenarioSnapshot } from './savedScenarios'

export function SavedScenariosView({ form, result, onOpen, onShare }: { form: ScenarioFormState; result: BrowserSimulationResult | null; onOpen: (item: SavedScenario) => void; onShare: (form: ScenarioFormState) => Promise<void> }) {
  const [items,setItems]=useState(() => loadSavedScenarios(localStorage))
  const [selected,setSelected]=useState<string[]>([])
  const [baselineId,setBaselineId]=useState<string|null>(null)
  const [status,setStatus]=useState<string|null>(null)
  const [error,setError]=useState<string|null>(null)
  const [dialogError,setDialogError]=useState<string|null>(null)
  const [editing,setEditing]=useState<string|null>(null)
  const [editName,setEditName]=useState('')
  const dialog=useRef<HTMLDialogElement>(null)
  const opener=useRef<HTMLButtonElement>(null)
  const [name,setName]=useState('')
  const [comment,setComment]=useState('')

  useEffect(() => { const node=dialog.current; const restore=()=>opener.current?.focus(); node?.addEventListener('close',restore); return()=>node?.removeEventListener('close',restore) },[])
  useEffect(() => {
    const formNode = dialog.current?.querySelector('form')
    formNode?.querySelector('#save-dialog-error')?.remove()
    if (!dialogError || !formNode) return
    const message = document.createElement('p')
    message.id = 'save-dialog-error'; message.className = 'field-error'; message.setAttribute('role','alert'); message.textContent = dialogError
    formNode.insertBefore(message, formNode.querySelector('.hint'))
  }, [dialogError])
  const commit=(next:SavedScenario[],message:string):boolean => { try { persistSavedScenarios(localStorage,next); setItems(next); setError(null); setStatus(message); return true } catch { setError('Не удалось записать данные браузера. Проверьте доступное место и настройки приватности.'); return false } }
  const openSave=()=>{ setName('Сценарий '+new Date().toLocaleDateString('ru-RU')+', '+form.elevatorCount+' лифт.'); setComment(''); setError(null); setDialogError(null); dialog.current?.showModal() }
  const save=()=>{ try { const item=makeSavedScenario(form,result,name,comment,crypto.randomUUID(),new Date().toISOString()); if(commit([item,...items], 'Сценарий «'+item.name+'» сохранён.')) dialog.current?.close(); else setDialogError('Браузер не смог сохранить сценарий.') } catch(reason) { setDialogError(reason instanceof Error?reason.message:'Не удалось сохранить сценарий') } }
  const duplicate=(item:SavedScenario)=>{ if(items.length>=MAX_SAVED_SCENARIOS)return setError('Достигнут лимит 20 сценариев. Сначала удалите ненужный.'); const copy={...item,id:crypto.randomUUID(),name:uniqueCopyName(item.name,items),savedAt:new Date().toISOString()}; commit([copy,...items],'Создана копия «'+copy.name+'».') }
  const remove=(item:SavedScenario)=>{ if(!confirm('Удалить сценарий «'+item.name+'»? Это действие нельзя отменить.'))return; commit(items.filter((value)=>value.id!==item.id),'Сценарий удалён.'); setSelected((value)=>{const next=value.filter((id)=>id!==item.id);if(baselineId===item.id)setBaselineId(next[0]??null);return next}) }
  const rename=(item:SavedScenario)=>{ const next=editName.trim(); if(!next||next.length>80)return setError('Название должно содержать от 1 до 80 символов.'); commit(items.map((value)=>value.id===item.id?{...value,name:next,savedAt:new Date().toISOString()}:value),'Сценарий переименован.'); setEditing(null) }
  const toggle=(id:string)=>setSelected((current)=>{ if(current.includes(id)){const next=current.filter((value)=>value!==id);if(baselineId===id)setBaselineId(next[0]??null);return next} if(current.length>=3){setError('Для сравнения можно выбрать не более трёх сценариев.');return current} if(current.length===0)setBaselineId(id);return [...current,id] })
  const compared=selected.map((id)=>items.find((item)=>item.id===id)).filter((item):item is SavedScenario=>Boolean(item))
  const orderedCompared=baselineId ? [...compared].sort((a,b)=>a.id===baselineId?-1:b.id===baselineId?1:0) : compared

  return <section className="section-card saved-scenarios" aria-labelledby="saved-title">
    <div className="saved-heading"><div><span className="eyebrow">Библиотека вариантов</span><h2 id="saved-title">Сохранённые сценарии</h2><p>Они хранятся только в этом браузере. Очистка данных сайта удалит их; для коллег используйте ссылку.</p>{items.length>=MAX_SAVED_SCENARIOS&&<p id="saved-limit" className="limit-note">Лимит достигнут — удалите ненужный сценарий.</p>}</div><button ref={opener} className="primary-button" type="button" disabled={items.length>=MAX_SAVED_SCENARIOS} aria-describedby={items.length>=MAX_SAVED_SCENARIOS?'saved-limit':undefined} onClick={openSave}>Сохранить текущий</button></div>
    <div className="saved-toolbar"><strong>{items.length} из {MAX_SAVED_SCENARIOS}</strong><span>Для сравнения отметьте 2–3 рассчитанных сценария.</span></div>
    {status&&<div className="saved-status" role="status">{status}</div>}{error&&<div className="error-summary" role="alert">{error}</div>}
    {items.length===0?<div className="saved-empty"><strong>Сохранений пока нет</strong><p>Настройте или рассчитайте вариант и сохраните его, чтобы вернуться позже или сравнить с другим.</p></div>:<div className="saved-grid">{items.map((item)=><article className="saved-card" key={item.id}>
      <header>{editing===item.id?<div className="rename-row"><label className="sr-only" htmlFor={'rename-'+item.id}>Новое название</label><input id={'rename-'+item.id} value={editName} maxLength={80} onChange={(event)=>setEditName(event.target.value)} autoFocus/><button type="button" onClick={()=>rename(item)}>Готово</button><button type="button" onClick={()=>setEditing(null)}>Отмена</button></div>:<><div><h3>{item.name}</h3>{baselineId===item.id&&<span className="baseline-badge">Базовый сценарий</span>}<small>{new Date(item.savedAt).toLocaleString('ru-RU')}</small></div><label className="compare-check" title={item.snapshot?undefined:'Сначала рассчитайте сценарий'}><input type="checkbox" disabled={!item.snapshot} checked={selected.includes(item.id)} onChange={()=>toggle(item.id)}/>{item.snapshot?'К сравнению':'Нет расчёта'}</label></>}</header>
      {item.comment&&<p>{item.comment}</p>}<div className="saved-facts"><span>{item.form.elevatorCount} лифт.</span><span>{item.form.floorCount} эт.</span><span>{item.form.totalEmployees} чел.</span><span>{dispatchStrategyLabel(item.form.dispatchStrategy)}</span><span>seed #{item.form.seed}</span></div>
      {item.snapshot?<div className="saved-kpis"><span>Ожидание <strong>{duration(item.snapshot.waitingMeanSeconds)}</strong></span><span>P90 <strong>{duration(item.snapshot.waitingP90Seconds)}</strong></span><span>Маршрут <strong>{duration(item.snapshot.totalMeanSeconds)}</strong></span></div>:<p className="not-calculated">{item.migratedFromLegacy ? 'Сценарий обновлён для новой модели встреч — пересчитайте результат' : item.snapshotNeedsUpgrade ? 'Результат создан прежней версией сравнения — пересчитайте сценарий' : 'Настройки сохранены без результата'}</p>}
      <div className="saved-actions"><button type="button" onClick={()=>{if(JSON.stringify(form)!==JSON.stringify(item.form)&&!confirm('Заменить текущие настройки сценарием «'+item.name+'»?'))return; onOpen(item); setStatus('Открыт сценарий «'+item.name+'». Запустите расчёт, когда будете готовы.')}}>Открыть</button><details><summary>Ещё</summary><div><button type="button" onClick={(event)=>{closeMoreMenu(event.currentTarget);setEditing(item.id);setEditName(item.name)}}>Переименовать</button><button type="button" disabled={items.length>=MAX_SAVED_SCENARIOS} aria-describedby={items.length>=MAX_SAVED_SCENARIOS?'saved-limit':undefined} onClick={(event)=>{closeMoreMenu(event.currentTarget);duplicate(item)}}>Создать копию</button><button type="button" onClick={(event)=>{closeMoreMenu(event.currentTarget);void onShare(item.form)}}>Скопировать ссылку</button><button type="button" className="danger-action" onClick={(event)=>{closeMoreMenu(event.currentTarget);remove(item)}}>Удалить</button></div></details></div>
    </article>)}</div>}
    {orderedCompared.length>=2&&<Comparison items={orderedCompared} onBaseline={setBaselineId}/>} 
    <dialog ref={dialog} className="save-dialog" aria-labelledby="save-title"><form method="dialog" onSubmit={(event)=>{event.preventDefault();save()}}><h2 id="save-title">Сохранить сценарий</h2><p>Сохранятся параметры, seed и {result?'результат последнего расчёта':'настройки без результата'}.</p><label className="field"><span>Название</span><input autoFocus required maxLength={80} value={name} onChange={(event)=>setName(event.target.value)}/></label><label className="field"><span>Комментарий <small>{comment.length}/300</small></span><textarea maxLength={300} value={comment} onChange={(event)=>setComment(event.target.value)}/></label><p className="hint">Хранится только в этом браузере. Для передачи коллеге скопируйте ссылку.</p><div className="dialog-actions"><button type="button" onClick={()=>dialog.current?.close()}>Отмена</button><button className="primary-button" type="submit">Сохранить</button></div></form></dialog>
  </section>
}

type ComparisonMetricKey='waitingMeanSeconds'|'waitingMedianSeconds'|'waitingP90Seconds'|'totalMeanSeconds'|'totalMedianSeconds'|'maximumQueue'|'emptyFloorsTravelled'
type TimeMetricKey=Exclude<keyof ComparisonTimeSlice,'routeCount'>
type ComparisonView='wholeDay'|'morning'|'day'|'evening'|'hourly'
const periodLabels:Record<ComparisonView,string>={wholeDay:'Итого',morning:'Утро',day:'День',evening:'Вечер',hourly:'По часам'}
const hourlyMetrics:readonly [string,TimeMetricKey|'routeCount','time'|'count'][]=[
  ['Количество маршрутов','routeCount','count'],
  ['Ожидание — среднее','waitingMeanSeconds','time'],['Ожидание — медиана','waitingMedianSeconds','time'],['Ожидание — P90','waitingP90Seconds','time'],
  ['Поездка — среднее','ridingMeanSeconds','time'],['Поездка — медиана','ridingMedianSeconds','time'],['Поездка — P90','ridingP90Seconds','time'],
  ['Полный маршрут — среднее','totalMeanSeconds','time'],['Полный маршрут — медиана','totalMedianSeconds','time'],['Полный маршрут — P90','totalP90Seconds','time'],
]
function Comparison({items,onBaseline}:{items:SavedScenario[];onBaseline:(id:string)=>void}) {
  const [view,setView]=useState<ComparisonView>('wholeDay')
  const [hourlyMetric,setHourlyMetric]=useState<TimeMetricKey|'routeCount'>('waitingMeanSeconds')
  const baseline=items[0]
  const rows:[string,ComparisonMetricKey,'time'|'count'|'floors'][]=[['Среднее ожидание','waitingMeanSeconds','time'],['Медиана ожидания','waitingMedianSeconds','time'],['P90 ожидания','waitingP90Seconds','time'],['Среднее полного маршрута','totalMeanSeconds','time'],['Медиана полного маршрута','totalMedianSeconds','time'],['Максимальная очередь','maximumQueue','count'],['Пустой пробег','emptyFloorsTravelled','floors']]
  const periodRows:[string,TimeMetricKey,'time'][]=[['Среднее ожидание','waitingMeanSeconds','time'],['Медиана ожидания','waitingMedianSeconds','time'],['P90 ожидания','waitingP90Seconds','time'],['Среднее полного маршрута','totalMeanSeconds','time'],['Медиана полного маршрута','totalMedianSeconds','time']]
  const compatibility=new Map(items.slice(1).map((item)=>[item.id,comparisonCompatibility(baseline,item)]))
  const reasons=[...new Set([...compatibility.values()].flatMap((item)=>item.reasons))]
  const selectedHourly=hourlyMetrics.find(([,key])=>key===hourlyMetric)??hourlyMetrics[1]
  const visibleHours=Array.from({length:24},(_,hour)=>hour).filter((hour)=>items.some((item)=>(item.snapshot?.hourlySlices?.[hour]?.routeCount??0)>0))
  const periodUnavailable=view!=='wholeDay'&&view!=='hourly'&&items.some((item)=>item.snapshot?.periodSlices===null)
  const hourlyUnavailable=view==='hourly'&&items.some((item)=>item.snapshot?.hourlySlices===null)
  const periodReportsDiffer=view!=='wholeDay'&&view!=='hourly'&&[...compatibility.values()].some((item)=>item.reportsDiffer)
  return <section className="comparison" aria-labelledby="comparison-title"><header><div><h3 id="comparison-title">Сравнение</h3><p>Базовый сценарий: «{baseline.name}». Меньше — лучше для временных и эксплуатационных показателей.</p></div><span>{items.length} сценария выбрано</span></header>
    {reasons.length>0&&<div className="warning" role="status"><strong>Условия потока различаются.</strong> {reasons.join('. ')}. Для отмеченных сценариев значения показаны справочно без вывода «лучше/хуже».</div>}
    <div className="comparison-controls"><div className="comparison-tabs" role="tablist" aria-label="Период сравнения">{(['wholeDay','morning','day','evening','hourly'] as const).map((key)=><button type="button" role="tab" aria-selected={view===key} key={key} onClick={()=>setView(key)}>{periodLabels[key]}</button>)}</div>{view==='hourly'&&<label className="comparison-metric-select"><span>Показатель</span><select value={hourlyMetric} onChange={(event)=>setHourlyMetric(event.target.value as TimeMetricKey|'routeCount')}>{hourlyMetrics.map(([label,key])=><option key={key} value={key}>{label}</option>)}</select></label>}</div>
    {(periodUnavailable||hourlyUnavailable)&&<div className="warning" role="status">У части сохранений нет детализации для этого режима. Откройте, пересчитайте и сохраните их заново.</div>}
    {periodReportsDiffer&&<div className="warning" role="status">Границы утреннего, дневного или вечернего периода различаются. Значения показаны справочно без вывода «лучше/хуже».</div>}
    <p className="table-swipe">На узком экране проведите таблицу в сторону.</p>
    {view==='hourly'
      ? <HourlyComparison items={items} hours={visibleHours} metric={hourlyMetric} kind={selectedHourly[2]} onBaseline={onBaseline} compatibility={compatibility}/>
      : <MetricComparisonTable items={items} baseline={baseline} rows={view==='wholeDay'?rows:periodRows} view={view} onBaseline={onBaseline} compatibility={compatibility}/>
    }
  </section>
}
function MetricComparisonTable({items,baseline,rows,view,onBaseline,compatibility}:{items:SavedScenario[];baseline:SavedScenario;rows:readonly [string,ComparisonMetricKey|TimeMetricKey,'time'|'count'|'floors'][];view:Exclude<ComparisonView,'hourly'>;onBaseline:(id:string)=>void;compatibility:Map<string,ReturnType<typeof comparisonCompatibility>>}) {
  const value=(item:SavedScenario,key:ComparisonMetricKey|TimeMetricKey):number|null => view==='wholeDay' ? (item.snapshot?.[key as ComparisonMetricKey]??null) : (item.snapshot?.periodSlices?.[view]?.[key as TimeMetricKey]??null)
  return <div className="result-table-scroll" tabIndex={0} role="region" aria-label={`Сравнение сценариев: ${periodLabels[view].toLowerCase()}`}><table className="result-table comparison-table"><caption className="sr-only">Сравнение сохранённых сценариев: {periodLabels[view].toLowerCase()}</caption><ComparisonHead items={items} onBaseline={onBaseline} compatibility={compatibility}/><tbody>{rows.map(([label,key,kind])=><tr key={key}><th scope="row">{label}</th>{items.map((item,index)=>{const current=value(item,key);if(index===0)return <td key={item.id}><strong>{formatValue(current,kind)}</strong><small>Базовое значение</small></td>;const status=compatibility.get(item.id);const allowVerdict=(status?.paired??false)&&(view==='wholeDay'||status?.reportsDiffer===false);const compared=compareMetric(current,value(baseline,key),allowVerdict);return <td key={item.id}><strong>{formatValue(current,kind)}</strong><small className={`comparison-${compared.verdict}`}>{formatComparison(compared,kind)}</small></td>})}</tr>)}</tbody></table></div>
}
function HourlyComparison({items,hours,metric,kind,onBaseline,compatibility}:{items:SavedScenario[];hours:number[];metric:TimeMetricKey|'routeCount';kind:'time'|'count';onBaseline:(id:string)=>void;compatibility:Map<string,ReturnType<typeof comparisonCompatibility>>}) {
  return <div className="result-table-scroll" tabIndex={0} role="region" aria-label="Почасовое сравнение сценариев"><table className="result-table comparison-table hourly-comparison-table"><caption className="sr-only">Почасовое сравнение сохранённых сценариев</caption><ComparisonHead items={items} onBaseline={onBaseline} compatibility={compatibility} firstColumn="Час"/><tbody>{hours.length===0?<tr><td colSpan={items.length+1}>Нет почасовых данных. Пересчитайте и сохраните выбранные сценарии.</td></tr>:hours.map((hour)=><tr key={hour}><th scope="row">{String(hour).padStart(2,'0')}:00</th>{items.map((item)=><td key={item.id}><strong>{formatValue(item.snapshot?.hourlySlices?.[hour]?.[metric]??null,kind)}</strong></td>)}</tr>)}</tbody></table></div>
}
function ComparisonHead({items,onBaseline,compatibility,firstColumn='Показатель'}:{items:SavedScenario[];onBaseline:(id:string)=>void;compatibility:Map<string,ReturnType<typeof comparisonCompatibility>>;firstColumn?:string}) {
  return <thead><tr><th>{firstColumn}</th>{items.map((item,index)=><th key={item.id}>{item.name}{index===0?<small>База</small>:<>{!compatibility.get(item.id)?.paired&&<small>Поток отличается</small>}<button type="button" onClick={()=>onBaseline(item.id)}>Сделать базовым</button></>}</th>)}</tr></thead>
}
function formatValue(value:number|null,kind:string):string { if(value===null)return 'Нет данных'; if(kind==='time')return duration(value); if(kind==='floors')return Number(value.toFixed(1))+' эт.'; return value+' чел.' }
function duration(value:number|null):string { if(value===null)return '—'; const seconds=Math.round(value); return seconds<60?seconds+' с':Math.floor(seconds/60)+' мин '+seconds%60+' с' }
function formatComparison(value:ReturnType<typeof compareMetric>,kind:'time'|'count'|'floors'):string { if(value.absoluteDelta===null)return 'Нет сопоставимых данных'; const sign=value.absoluteDelta<0?'−':value.absoluteDelta>0?'+':''; const magnitude=Math.abs(value.absoluteDelta); const formatted=kind==='time'&&magnitude<10?Number(magnitude.toFixed(1))+' с':formatValue(magnitude,kind); const absolute=sign+formatted; const relative=value.relativeDelta===null?'% не рассчитывается: база 0':(value.relativeDelta>0?'+':'')+(value.relativeDelta*100).toFixed(1)+'%'; const verdict=value.verdict==='better'?'↓ лучше':value.verdict==='worse'?'↑ хуже':value.verdict==='same'?'без изменений':'сравнение справочное'; return `${absolute} (${relative}) · ${verdict}` }
export function uniqueCopyName(name:string,items:SavedScenario[]):string { let index=1; while(true){ const suffix=index===1?' — копия':' — копия '+index; const candidate=name.slice(0,80-suffix.length)+suffix; if(!items.some((item)=>item.name===candidate))return candidate; index+=1 } }
function closeMoreMenu(button: HTMLButtonElement): void { button.closest('details')?.removeAttribute('open') }
