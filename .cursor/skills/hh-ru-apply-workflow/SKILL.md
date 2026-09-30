---
name: hh-ru-apply-workflow
description: >-
  Maps hh.ru automation in this repo: Playwright scripts, vacancies queue, dashboard,
  cover letter fill vs chat apply, selector files. Use when editing or running hh-ru-apply,
  debugging Playwright flows, or answering questions about npm scripts, data paths, and
  hh.ru response/chat automation.
---

# hh-ru-apply — рабочий контур

## Стек и запуск

- Node.js **18+**, проект на **ESM** (`"type": "module"` в [package.json](package.json)).
- После `npm install` при необходимости: `npx playwright install chromium`.
- Список команд — в `scripts` внутри [package.json](package.json); ниже — смысл.

## Сценарии (`npm run …`)

| Команда | Назначение |
|--------|------------|
| `login` | Сохранение сессии hh.ru в профиле Chromium. |
| `apply` | Проверка, что сохранённая сессия жива. |
| `dashboard` | Локальный UI: очередь вакансий, письма, запуск сценариев. |
| `scan-tg` | Вакансии из Telegram (см. переменные в [.env.example](.env.example)). |
| `vacancies` | Открытие вакансий с hh по ключевым словам. |
| `harvest` | Сбор очереди: PHP → JS → лид (техдир/тимлид) → IT/технический PM (резюме CTO), всё + удалёнка; до ~20 новых за проход. |
| `hh-fill-letter` | Вставка сопроводительного в **форму отклика** на странице вакансии; **отправку не нажимает** — пользователь проверяет и жмёт сам. |
| `hh-apply-chat` | Сценарий **отклик + письмо в чат** с работодателем (не textarea формы на карточке). |
| `hourly` | Один цикл: окно логина (если сессия жива — сразу закрывается) → harvest + отклики headless до лимита в час. |
| `hourly:install` | launchd: каждый час в :20 и :40 тот же цикл. |
| `hourly:uninstall` | Снять launchd. |

Типичные флаги отладки у скриптов с браузером: `--stay-open` (см. [README.md](README.md)).

## Данные и конфиг

Источник путей: [lib/paths.mjs](lib/paths.mjs).

| Путь / переменная | Назначение |
|-------------------|------------|
| `data/vacancies-queue.json` | Очередь вакансий; у записи есть `id` для `--id=…`. |
| `data/skipped-vacancies.jsonl` | Пропущенные вакансии. |
| `data/feedback.jsonl` | Обратная связь. |
| `data/cover-letter-user-edits.jsonl` | Правки писем пользователем. |
| `data/hh-apply-chat.log` | Лог сценария «отклик в чате». |
| `HH_SESSION_DIR` / `data/session/chromium-profile` | Профиль браузера (см. [.env.example](.env.example)). |
| `HH_PROXY` | SOCKS5/HTTP только для Chromium hh; OpenRouter идёт без него (VPN). |
| `config/preferences.json` | Настройки приложения. |
| `CV/` | PHP-резюме для скоринга. `CV/js/` — Frontend/JS. `CV/lead/` — CTO. |

Секреты и ключи не дублировать в ответах; ориентир — [.env.example](.env.example) и `config/secrets.example.env` / локальные файлы из доков.

## Селекторы Playwright (где чинить поломки UI)

- **Форма отклика** (кнопка «Откликнуться», поле письма в модалке): [lib/hh-response-selectors.mjs](lib/hh-response-selectors.mjs), скрипт [scripts/hh-fill-response-letter.mjs](scripts/hh-fill-response-letter.mjs).
- **Отклик + чат**: [lib/hh-chat-selectors.mjs](lib/hh-chat-selectors.mjs), скрипт [scripts/hh-apply-chat-letter.mjs](scripts/hh-apply-chat-letter.mjs).

При смене вёрстки hh.ru: открыть нужную страницу вручную, `npm run codegen-hh`, обновить селекторы **в этих lib-файлах** (не размазывать по проекту). Дополнительно — паузы/джиттер: [lib/hh-human-delay.mjs](lib/hh-human-delay.mjs), лимиты: [lib/hh-apply-rate.mjs](lib/hh-apply-rate.mjs).

## Ограничения и ожидания

- Массовая автоматизация откликов может **противоречить правилам** hh.ru; проект рассчитан на **умеренное** использование и ручной контроль.
- Возможны **капча** и другие защиты — закладывать **ручной вход** и реалистичные паузы.
- Не отключать и не обходить human-delay / rate-limiting **ради скорости**, если пользователь явно не попросил.
- Harvest: PHP + удалёнка, затем JS/frontend, затем техлид/тимлид/системный архитектор, затем IT/technical/digital project manager (резюме CTO). Ключи уже не только PHP/JavaScript: Laravel, Node/Nest, Vue/React/TS, React Native, VoIP, DevOps, Unity, CIO/EM/архитектор. Python/Java на JS, лид и PM отсекаются. Продажи, менеджеры, клиенты, маркетологи, контакт-центр, Битрикс и 1С — не harvest и не отклик, кроме Engineering Manager / Head of Engineering и IT/технического project manager. Голый «архитектор» (дома, Ревит, интерьеры) — бан; системный / software / solution / архитектор ПО — да. Отклик водопадом: PHP → JS → CTO → PM. Лимит 8/час общий. Если OpenRouter падает, Laravel/Node и соседний стек не пишутся с нулём — fallback ≥ порога отклика.
- `hh-apply-chat` / отклик из дашборда: **один отклик на вакансию**. Два нажатия «Откликнуться» (карточка → форма) — это один отклик, не два. Повторно на ту же вакансию не жать (`Резюме доставлено` / `hhAppliedAt`). Отклик на **внешний сайт** — пропуск (`hhApplySkipReason: external_site`), не слать. **Архив / недоступна** — пропуск (`archived` / `unavailable`), не крутить каждый час. Модалка «другая страна» — «Все равно откликнуться». Лимит 8/час считается только после реальной отправки.
- Резюме в модалке: PHP — **Backend/Fullstack + PHP**; JS — **Frontend/Fullstack**; лид и IT PM — **Chief Technical Officer** (`hhTracks` в [config/preferences.json](config/preferences.json)).

## Письма и стиль

Кратко: шаблон [config/cover-letter.example.txt](config/cover-letter.example.txt); личный файл (например `config/cover-letter.txt`) — в `.gitignore` по желанию. В дашборде после **Утвердить** письма попадают в очередь эталонов стиля для следующих генераций; опционально `config/cover-letter-style-examples.txt` (разделитель `---` на отдельной строке). Подробности и переменные окружения для LLM — [reference.md](reference.md).
