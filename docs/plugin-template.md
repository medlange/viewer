# Шаблон плагина: панель, которую не стыдно показать ревьюеру

`getting-started.md` заканчивается на минимальной панели. Этот шаблон — её
производственная форма: та же регистрация, но с дисциплиной, которую сьют требует
от штатного кода. Каждое правило в комментарии названо гейтом, который его проверяет.

Код в блоках ниже — не иллюстрация: `viewer/tests/test_plugin_template.py`
извлекает эти блоки и прогоняет по ним те же проверки, что сьют прогоняет по
штатным панелям. Гайд не может протухнуть, не заметив этого.

## Файл плагина

```js
// SPDX-License-Identifier: Apache-2.0
/* acme.dose-notes — заметки протокола в правом рельсе.
 *
 * ШАБЛОН ПЛАГИНА (V3): копируйте, меняйте id/рендер, сохраняйте форму. Вся
 * интеграция — register() плюс один import в app.js; оболочка строит секцию.
 */
import { KINDS, register } from '../core/registry.js';
import { get, subscribeTo } from '../core/state.js';
import { t, onLanguageChange } from '../core/i18n.js';

/** Одна эскейп-функция на весь плагин. Архивные строки — чужие байты. */
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function render(root) {
  const { series } = get();
  if (!series || !series.length) {
    // Пустое состояние — тоже состояние. Секция не должна выглядеть сломанной.
    root.innerHTML = `<p class="muted">${esc(t('dose.none', 'No study open.'))}</p>`;
    return;
  }
  const notes = series.length;
  root.innerHTML = `<p class="muted">${esc(
    t('dose.summary', '{n} series in this study').replace('{n}', String(notes)),
  )}</p>`;
}

export default register({
  id: 'acme.dose-notes',
  kind: KINDS.PANEL,
  title: 'Dose notes',
  order: 40,
  slot: 'right',
  mount(root) {
    render(root);
    const stop = subscribeTo(['series'], () => render(root));
    // Смена языка не меняет state — слушаем её отдельно, иначе подписи зависают.
    const stopLang = onLanguageChange(() => render(root));
    // ОТПИСКА ОБЯЗАТЕЛЬНА: mount вызывается повторно при перемонтировании, и без
    // возврата teardown панель рисуется дважды на каждое изменение состояния.
    return () => { stop(); stopLang(); };
  },
});
```

## Строки, которые добавляет плагин

1. `app.js`: `import './src/ui/dose-notes.js';` — рядом с другими импортами панелей.
2. `i18n/*.json` (13 файлов): ключи заголовка и подписей:

```json
{
  "panel.acme.dose-notes": "Заметки по дозе",
  "dose.none": "Нет открытого исследования.",
  "dose.summary": "Серий в исследовании: {n}"
}
```

3. `viewer/tests/test_dose_notes.py` — гейт-тест (см. testing.md); без него сьют
   пропустит плагин мимо, и правило «контрибуция = модуль + регистрация + тест»
   останется недоказанным.

## Что плагин получает бесплатно

- Секцию в рельсе с заголовком из `panel.<id>` и раскладкой по `order`.
- Перемонтирование и чистую уборку (оболочка держит `mountedPanels`).
- Возможность выключения deployment'ом: `viewer.config.json` → `panels.disabled`
  (V2) — без правок кода плагина.
- Перенос между рельсами читателем (rails.js) — секция двигается, плагин не знает.

## Чего плагин не может

- Импортировать `app.js` или что-либо из `src/ui/*` в `src/core/*` — правило
  no-shell-import, гейт `test_architecture.py` падает в обе стороны.
- Лезть в сеть напрямую: панель читает state, который заполняет оболочка. Свои
  запросы — через plugin API (`api.dicomweb` — тот же сконфигурированный клиент,
  с Authorization хоста): см. [extensions.md](extensions.md) и
  [api.md](api.md) — шов, который раньше был «отдельным решением», существует.
- Писать в DOM вне своего `root`: оболочка владеет раскладкой.
