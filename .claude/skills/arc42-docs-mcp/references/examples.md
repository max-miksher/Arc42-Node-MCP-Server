---
title: Примеры product-профиля
type: reference
status: active
updated: 2026-10-23
---

# Примеры вызовов

Пути ниже — значения стандартной раскладки. Для custom mapping используй пути из status/get-section и `.arc42.yaml`. Запросы показаны как arguments соответствующего MCP tool. Даты и утверждения заполняй по текущим фактам.

## Новый проект

`arc42-init`:

```json
{"projectName":"Example","profile":"product","language":"RU","format":"markdown","scaffold":"minimal","targetFolder":"/absolute/project"}
```

Ответ содержит docs-relative `requirement` и конфигурацию. Корневой файл Level 1 создан как draft. Перед добавлением деталей уточни реальные границы и ответственности.

## Блок и вложенная декомпозиция

`arc42-document {action:"create", path:"architecture/05-building-block-view/building-blocks/api/README.md", content:<Markdown ниже>}`:

```markdown
---
title: API
type: architecture
status: draft
updated: 2026-10-23
kind: building-block
parent: architecture/05-building-block-view/README.md
code: src
---

# API

Принимает запросы клиента. Отвечает за проверку входного контракта.
```

Добавь ссылку в родительский документ через read → edit. Для внутренних частей API путь: `.../api/building-blocks/validation/README.md`, `parent: .../api/README.md`. Дополнительное поле:

```yaml
decomposition:
  trigger: 3
  evidence:
    - requirements/2026-10-23-change-api/описание.md
```

Используй путь существующего требования текущей работы; пример пути выше замени фактическим. Новое требование создавай только для нового запроса. В тексте блока объясни конкретное изменение внутренних интерфейсов, которое невозможно описать blackbox. Выбранный номер берётся из текущего нормативного профиля: сервер проверяет 1..5 и ссылки, человек/агент — содержательное условие.

## Runtime-сценарий

Путь: `architecture/06-runtime-view/scenarios/request.md`. Содержание для `action:"create"`:

```markdown
---
title: Обработка запроса
type: architecture
status: draft
updated: 2026-10-23
kind: runtime-scenario
blocks:
  - architecture/05-building-block-view/building-blocks/api/README.md
---

# Обработка запроса

1. Клиент вызывает API.
2. API проверяет входной контракт.
3. При неверном формате API возвращает ошибку и не меняет состояние.
```

Ссылка blocks должна указывать на реальный существующий блок. Корневое представление Level 1 не является отдельным участником. Добавь ссылку из документа раздела 6; если его ещё нет — создай его как architecture с frontmatter и навигацией.

## Отдельный MADR

Путь: `architecture/09-architecture-decisions/ADR-0001-storage.md`:

```markdown
---
title: Хранение документов в Markdown
type: adr
status: draft
updated: 2026-10-23
date: 2026-10-23
decision_status: proposed
---

# Хранение документов в Markdown

## Context and Problem Statement

Нужны история изменений и review архитектурной документации в Git.

## Considered Options

- Markdown в репозитории
- Отдельная wiki

## Decision Outcome

Предложен Markdown в репозитории, поскольку изменение документа можно проверить вместе с кодом.
```

`date` и `decision_status` — явный контракт локального адаптера; полный MADR не объявляет все свои метаданные обязательными. `decision-makers` добавляй списком, когда участники известны. Не выдумывай их. Используется MADR minimal 4.0; английские заголовки — стабильные ключи валидатора, текст может быть на любом языке. decision_status: proposed/accepted/rejected/deprecated/superseded. status описывает жизненный цикл документа; принятие решения отдельно меняет decision_status.

Номер ADR выбирай после инвентаризации каталога решений; одинаковые номера недопустимы. В секции 9 храни ссылки на отдельные ADR, а не копии их текста.

## Точечная правка

`arc42-document`:

```json
{"action":"read","path":"architecture/05-building-block-view/README.md"}
```

Используй возвращённый sha256 без пересчёта/угадывания:

```json
{"action":"edit","path":"architecture/05-building-block-view/README.md","expectedHash":"<sha256 из ответа>","oldText":"<уникальный существующий фрагмент>","newText":"<тот же фрагмент с нужным изменением>"}
```

Отсутствующее или повторное совпадение и конфликт версии оставляют файл прежним. Неизвестные поля frontmatter сохраняй. Чтение повреждённого frontmatter возвращает metadataError: исправь его точечным патчем, сохранив старое содержание.

## Legacy

`arc42-inventory {roots:["legacy-docs"], maxFiles:5000}`. Затем `arc42-migration-plan`:

```json
{"requirement":"requirements/2026-10-23-change-api/описание.md","items":[{"source":"legacy-docs/ARCH.md","target":"architecture/03-context-and-scope/README.md","reason":"Описывает границу API, изменяемую этим требованием"}]}
```

Source относительно репозитория, requirement/target относительно docsDir. Сверь возвращённые хеши перед отдельной ручной миграцией. План не изменяет source/target и не подтверждает их содержательную согласованность.

Заверши `arc42-validate {}` и review затронутых активных документов относительно требования и кода.
