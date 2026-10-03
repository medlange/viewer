# Панель за 30 строк

Это пошаговое руководство: от пустого файла до смонтированной панели в правом рельсе,
без единой правки ядра, кроме одной строки-импорта (это и есть точка расширения).
Каждый шаг проверяем командой из шага 6.

## Шаг 1 — файл панели

Создайте `src/ui/series-inventory-panel.js`:

```js
// Счётчик серий по модальностям открытого исследования.
import { KINDS, register } from '../core/registry.js';
import { get, subscribeTo } from '../core/state.js';
import { t, onLanguageChange } from '../core/i18n.js';

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function render(root) {
  const { series } = get();
  if (!series || !series.length) {
    root.innerHTML = `<p class="muted">${esc(t('inv.none', 'No study open.'))}</p>`;
    return;
  }
  const byModality = {};
  for (const row of series) {
    const m = (row['00080060'] && row['00080060'].Value[0]) || '?';
    byModality[m] = (byModality[m] || 0) + 1;
  }
  root.innerHTML = '<ul class="muted">' + Object.entries(byModality)
    .map(([m, n]) => `<li>${esc(m)} — ${n}</li>`).join('') + '</ul>';
}

export default register({
  id: 'acme.series-inventory',
  kind: KINDS.PANEL,
  title: 'Series inventory',
  order: 40,
  slot: 'right',
  mount(root) {
    render(root);
    const stop = subscribeTo(['series'], () => render(root));
    const stopLang = onLanguageChange(() => render(root));
    return () => { stop(); stopLang(); };
  },
});
```

30 строк кода. Что здесь важно:

- `register()` — вся интеграция. Оболочка сама построит секцию в рельсе (`slot`,
  `order`), заголовок возьмёт из i18n-ключа `panel.<id>`.
- `mount(root)` получает элемент и возвращает функцию отписки. Оболочка вызывает её
  при перемонтировании — утечка подписки выглядит как мерцание, гейт это ловит.
- Панель читает только `core/state`. Никаких импортов `app.js` — это запрещено
  архитектурным гейтом (`test_architecture.py` падает на таком импорте).
- `esc()` перед каждым `innerHTML`. Архивные строки — чужие байты.
- Переводимые подписи через `t()` с английским литералом-фолбэком; архивные значения
  (имена, UID) НЕ переводятся — см. шаг 4.

## Шаг 2 — одна строка в оболочке

В `app.js`, рядом с остальными импортами панелей:

```js
import './src/ui/series-inventory-panel.js'; // registers the panel
```

Импорт ради побочного эффекта регистрации — так подключены все штатные панели.

## Шаг 3 — строки в локали

Заголовок секции берётся из ключа `panel.acme.series-inventory`. Добавьте его во все
файлы `i18n/*.json` (13 языков; английского файла нет — он литералы в коде):

```json
"panel.acme.series-inventory": "Серии"
```

Гейт `test_every_language_answers_every_key_the_others_do` упадёт, если ключ есть не
во всех файлах, — это фича: таблицы не расходятся.

## Шаг 4 — правило перевода одной строкой

Подписи, которые вы пишете — переводите (`t('inv.none', ...)`). Значения из DICOM —
нет: имя пациента в viewer'е должно совпадать с именем в PACS побайтово. Гейт
`test_translation_never_reaches_a_measured_value_or_the_safety_statement` следит за
границей с той стороны.

## Шаг 5 — посмотреть

```bash
docker compose -f medos/deploy/compose/docker-compose.yml up -d web
# откройте http://localhost:3000/mos-viewer/ и откройте исследование
```

Панель стоит в правом рельсе под «Измерениями» (`order: 40` после штатных 10/20/30).
Deployment может выключить её без правок кода: `viewer.config.json` →
`"panels": {"disabled": ["acme.series-inventory"]}` (V2).

## Шаг 6 — гейт-тест

Скопируйте `viewer/tests/test_plugin_template.py` за образец и добавьте свои проверки,
затем:

```bash
cd viewer && python -m pytest tests
```

Весь сьют — 244 теста, ~2 секунды, node не нужен: тесты читают исходники так же, как
их читает ревьюер. Правила, которые ваш код уже соблюдает, если вы шли по гайду:
ни одного импорта оболочки из `src/ui/*`, `mount` возвращает отписку, каждая строка
UI — во всех локалях. Дальше — [plugin-template.md](plugin-template.md)
(производственная форма панели) и [testing.md](testing.md) (как писать тесты).
