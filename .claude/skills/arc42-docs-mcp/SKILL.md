---
name: arc42-docs
description: Use when creating or maintaining arc42 architecture documentation through Arc42 MCP Server, including building blocks, runtime scenarios, separate MADR, metadata validation and requirement-scoped legacy migration.
metadata:
  modified-by: Bondar Maksim
  modified: 2026-10-23
---

# Архитектурная документация через MCP

Сначала прочитай текущее требование и релевантные активные документы. Не подменяй фактическое состояние шаблоном. При конфликте requirement, кода и активного документа вынеси конфликт владельцу.

## Выбор режима

Вызови `arc42-status`. `data.profile: product` означает настраиваемое Markdown-дерево; пути разделов возвращают `get-section` и status. Старый workspace находится в `arc42-docs/` и сохраняет Markdown/AsciiDoc, 11 языков и шесть upstream tools.

Если status не видит workspace, прочитай `arc42-inventory` перед инициализацией. Отсутствие конфигурации не означает отсутствие документации. Не запускай init поверх существующих материалов.

Новый проект: `arc42-init {projectName, profile:"product", language:"RU", format:"markdown"}`. По умолчанию создаются индекс, requirement и Level 1. `docsDir` и `sections` задают физическую раскладку; `scaffold:"full"` явно создаёт 12 черновиков. Пустые каталоги не создаются. Все вызовы могут указывать абсолютный `targetFolder` корня проекта.

## Продуктовый профиль

Критерии углубления и локальные нормативные правила: [профиль владельца, 2026-10-12](https://drive.google.com/file/d/18g_j2ehMx76VEU0RKGZ_lTD90Am3EyVA/view). Если источник недоступен и смысл триггера неизвестен, не углубляй блок по одному номеру; запроси релевантное условие у владельца.

`arc42-document` адресует `.md` относительно настроенного docsDir:

1. `action:"read", path` возвращает content и sha256.
2. `action:"edit", path, expectedHash, oldText, newText` меняет ровно одно точное совпадение. При конфликте прочитай документ заново, сверь изменение с текущим текстом; не повторяй старую запись.
3. `action:"create", path, content` создаёт новый файл без перезаписи. Содержимое начинается с YAML frontmatter: title, type, status, updated (действительная дата YYYY-MM-DD).

`get-section` читает корневой документ раздела, а не склеивает дочерние файлы. `update-section` в product-режиме требует expectedHash; для точечной правки используй document edit. Метаданные и неизвестные поля сохраняй. Статусы документа: draft, active, deprecated, superseded. Для superseded нужна docs-relative ссылка superseded_by. Типы и поля связей описаны в [примерах](references/examples.md).

Building Blocks: Level 1 обязателен. Дочерние документы — `building-blocks/<имя>/README.md` внутри каталога родителя, `type: architecture`, `kind: building-block`, `parent` с docs-relative путём. Для уровня внутренних частей нужны `decomposition.trigger` (1..5 из нормативного профиля) и `decomposition.evidence` с путями requirement/ADR/scenario/risk/quality requirement. Номер триггера не доказывает его истинность: прочитай evidence и проверь условие. Не создавай полный arc42 для каждого блока.

Runtime: отдельные `.md` в `scenarios/` раздела 6, `kind: runtime-scenario`, `blocks` — docs-relative пути существующих Building Blocks. Описывай архитектурно значимые взаимодействия, включая ошибки.

ADR: отдельный `ADR-xxxx-slug.md` в каталоге раздела 9, `type: adr`. MADR minimal: Context and Problem Statement, Considered Options, Decision Outcome. Локальный адаптер отделяет status документа от decision_status решения; точные поля и пример — в references/examples.md. Добавь навигационную ссылку из секции 9 безопасной правкой. Не копируй ADR в общий файл.

После записи вызови `arc42-validate`. Ошибки и truncated требуют устранения или явного отчёта; предупреждение draft не равно готовой архитектуре. Валидатор проверяет синтаксис и явные связи. Истинность относительно кода, C4-нотацию, содержательную согласованность и актуальность затронутых active-документов проверяй отдельно.

## Legacy

`arc42-inventory {roots:["old-docs"]}` читает исходники, показывает metadata errors, hashes, дубли и ограничения. Это подсказки для классификации, не новый источник истины.

`arc42-migration-plan {requirement, items:[{source,target,reason}]}` готовит план без записи. requirement и target относительны docsDir; source — корню репозитория. Выбирай только документы, нужные текущему требованию. План не разрешает автоматически переносить, удалять, переписывать или менять статус исходника. При замене явно свяжи старый документ с новым; тот же объект обновляй на месте.

## Upstream workspace

Сохраняются arc42-workflow-guide, arc42-init, arc42-status, generate-template, get-section, update-section. Язык и формат берутся из config.yaml. Read → edit review → write; replace перезаписывает весь раздел, append добавляет текст. Старый режим не получает гарантий product-профиля. `force:true` уничтожает прежнее содержимое — только при прямом задании пользователя начать заново. Не предлагай такую операцию для миграции.

Установка и подключение: [setup](references/setup.md). Сценарии и метаданные: [examples](references/examples.md). Схемы в tools/list являются источником истины для аргументов.
