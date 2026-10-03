# Тесты viewer'а: как сьют устроен и как писать свой

Сьют — `viewer/tests/`, 244 теста, ~2 секунды, без node и без сборки. Тесты написаны
на Python и читают исходники так же, как их читает ревьюер: построчно, regex'ами,
AST. Это сознательный выбор поверх js-раннера — см. последний раздел.

## Запуск

```bash
cd viewer && python -m pytest tests           # всё, из домашней директории viewer'а
python -m pytest viewer/tests/test_upload.py -q   # один файл — с корня репозитория
```

Из корня репозитория тоже работает (`testpaths` включает `viewer/tests`), но владелец
viewer'а живёт в `viewer/`.

## Пять правил, которые сьют держит за всех

1. **Ни одного импорта оболочки из модулей.** `src/ui/*` и `src/core/*` не импортируют
   `app.js`. Тест — `test_architecture.py::test_every_registered_contribution_module_
   is_imported_by_the_shell` и соседние. Ваша панель получает всё через `register()`.
2. **Каждая строка UI — во всех локалях.** Новый ключ в одном `i18n/*.json` падает
   в `test_every_language_answers_every_key_the_others_do`. Тринадцать файлов, один
   проход — таблицы не расходятся.
3. **Перевод не дотрагивается до измеренного.** DICOM-значения и safety-строки не
   проходят через `t()` — `test_translation_never_reaches_a_measured_value_or_the_
   safety_statement`.
4. **Contribution не существует, пока о нём не импортировано.** Зарегистрировали
   модуль — добавьте импорт в `app.js`; гейт сверяет реестр с импортами.
5. **Отказ — предложение, а не тишина.** Кнопка, которая молча не работает, учит
   читателя не нажимать кнопки. Каждый отказ рендерится предложением платформы
   (см. `ai-dialog.js`, `upload.js`).

## Скелет теста для вашей контрибуции

```python
# viewer/tests/test_dose_notes.py
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PANEL = (ROOT / "src" / "ui" / "dose-notes.js").read_text(encoding="utf-8")


def test_the_panel_registers_and_cleans_up() -> None:
    assert "KINDS.PANEL" in PANEL
    assert "register({" in PANEL
    assert "mount(root)" in PANEL
    assert "return () => { stop(); stopLang(); };" in PANEL, (
        "mount must return its teardown: a remount without it draws twice per change"
    )


def test_the_panel_never_reaches_the_shell() -> None:
    assert "from '../app.js'" not in PANEL
    assert "from '../../app.js'" not in PANEL
```

Дальше — проверки смысла вашей панели: какие ключи state она читает, какие строки
рендерит, что показывает при пустом состоянии.

## Почему не js-тесты

У viewer'а нет шага сборки и нет node-зависимости — сьют не должен её вводить.
Строковые гейты дешевы, стабильны и читаются ревьюером; поведенческая логика
(рендер, DICOM-разбор) покрыта платформенными интеграционными тестами и живыми
прогонами (см. ROADMAP, G-U3/G-U4: каждая фича закрывалась браузерной проверкой).
Когда появится первый seam, требующий исполнения JS (динамические плагины), —
вот тогда и появится js-раннер, отдельным решением.

## Пример из жизни

`upload.js` (U4) пришёл вместе с `test_upload.py`: восемь гейтов пинят multipart-форму
STOW-RS (ручная сборка, не FormData), цель `{root}/studies`, показ
FailedSOPSequence, drag-drop с обязательным `preventDefault`, seam с оболочкой
и наличие строк во всех 13 локалях. Читая этот тест, вы читаете контракт фичи.
