---
title: Установка собственного Arc42 MCP Server
type: how-to
status: active
updated: 2026-10-23
---

# Установка

Нужны Git и Node.js 24+. Сервер работает локально через stdio. Путь проекта передаётся аргументом; перезапуск MCP-клиента нужен после обновления сборки.

```bash
git clone --recurse-submodules https://github.com/max-miksher/Arc42-Node-MCP-Server.git
cd Arc42-Node-MCP-Server
git switch feat/profile-workspace
npm ci
npm run build
npm test -- --run
```

Эта ветка содержит доработки форка. `npm install @h2nguyen/arc42-node-mcp-server` устанавливает upstream без продуктового профиля. Пакет форка ещё не опубликован в npm; подключай собранный файл из своего checkout. После установки зафиксируй используемый commit в своей конфигурации развёртывания.

Пример настройки MCP-клиента:

```json
{
  "mcpServers": {
    "arc42": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/Arc42-Node-MCP-Server/dist/index.js", "/absolute/path/to/project"]
    }
  }
}
```

На Windows используй абсолютные Windows-пути с экранированием `\\`. Если сервер запускается в WSL, Node и оба пути должны относиться к одной WSL-среде. MCP-клиент должен уметь запускать эту среду. Значение `targetFolder` переопределяет проект для одного вызова и всегда должно быть абсолютным. Каталоги через symlink отклоняются; укажи реальный путь.

В `tools/list` должны быть 10 инструментов: шесть upstream и arc42-document, arc42-validate, arc42-inventory, arc42-migration-plan. `stdout` занят MCP JSON-RPC; логи идут в stderr. Проверка stdio выполняется автоматически тестом `mcp-protocol-contract.test.ts` после сборки.

# Skill

Канонический Skill форка: [.claude/skills/arc42-docs-mcp/SKILL.md](../../.claude/skills/arc42-docs-mcp/SKILL.md). Он включён в пакет вместе с references.

Для Claude Code каталог уже расположен в проектном `.claude/skills/`. Для Codex скопируй весь каталог `arc42-docs-mcp` в `.agents/skills/` проекта либо в свой каталог Skill. Это установка копии: при обновлении сервера обновляй и её. Не создавай несколько независимо редактируемых версий Skill внутри одного проекта. Установка Skill не подключает MCP автоматически — сервер нужно добавить в настройках клиента.

# Первое использование

1. `arc42-status` — определить существующий режим.
2. `arc42-inventory` — проверить legacy, если документация уже существует без поддержанной конфигурации.
3. Только для нового проекта: `arc42-init {projectName:"Example", profile:"product", language:"RU", format:"markdown"}`.
4. Прочитать возвращённый requirement и Level 1. Создавать только документы, нужные текущей работе.
5. `arc42-validate` — проверить структуру; затем проверить содержание относительно требования и кода.

Профиль: [контракт](../reference/product-profile.md). Конкретные документы и MCP-вызовы: [примеры Skill](../../.claude/skills/arc42-docs-mcp/references/examples.md).

# Обновления upstream

После клонирования своего форка настрой remote один раз:

```bash
git remote add upstream https://github.com/h2nguyen/Arc42-Node-MCP-Server.git
git fetch upstream
```

Для обновления создай отдельную ветку от своей рабочей версии, слей выбранный upstream commit и разреши конфликты в конфигурации пакета, tool registry и расширенных обработчиках. Затем `npm ci`, `npm run build`, `npm test -- --run`, `npm run test:coverage -- --run`, `npm pack --dry-run`. Не обновляй vendor submodule молча: проверь изменения и лицензии. При необходимости официальный `npm run update:arc42` обновляет submodule отдельно.

# Восстановление

При конфликте expectedHash прочитай текущий документ и пересмотри патч. При `.arc42.lock` сначала проверь, что другой процесс не пишет. После подтверждённого падения сервера проверь git diff и содержимое lock, затем удали только этот оставшийся lock. Частичный init сохраняет созданные файлы и возвращает ошибку; инвентаризируй их и восстанови конфигурацию/недостающие документы вручную. Не запускай force для восстановления.
