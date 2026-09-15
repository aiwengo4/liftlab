/// <reference lib="webworker" />
import { runScenarioFromForm } from './scenarioRunner'
import { prepareBrowserResult } from './browserResult'
import type { ScenarioFormState } from './scenarioForm'
declare const self: DedicatedWorkerGlobalScope
self.onmessage = (event: MessageEvent<ScenarioFormState>) => {
  try {
    const result = runScenarioFromForm(event.data)
    // Трассы, состояние и журнал уже свёрнуты в метрики. Их пересылка раньше
    // раздувала сообщение worker до десятков мегабайт.
    self.postMessage({ ok: true, result: prepareBrowserResult(result) })
  }
  catch (error) { self.postMessage({ ok: false, error: error instanceof Error ? error.message : 'Не удалось выполнить расчёт' }) }
}
