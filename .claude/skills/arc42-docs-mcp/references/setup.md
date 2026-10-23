# Подключение сервера

Нужны Git и Node.js 24+. Пакет форка не опубликован в npm; upstream-пакет не
содержит этих расширений. Установи из существующей ветки форка:

```bash
git clone --recurse-submodules https://github.com/max-miksher/Arc42-Node-MCP-Server.git
cd Arc42-Node-MCP-Server
git switch feat/profile-workspace
npm ci
npm run build
```

Настрой MCP-клиент:

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

Для Windows используй абсолютные Windows-пути с экранированием обратной косой черты.
При WSL Node и оба пути должны быть из одной WSL-среды. targetFolder переопределяет
проект для отдельного вызова и должен быть абсолютным. Укажи реальные пути без symlink.

После подключения tools/list должен вернуть шесть upstream-инструментов и
arc42-document, arc42-validate, arc42-inventory, arc42-recover. Перезапусти сервер
после новой сборки. stdout предназначен только для MCP JSON-RPC.

Skill не подключает сервер автоматически. Копируй весь каталог arc42-docs-mcp
с references в .claude/skills/ или .agents/skills/ своего проекта; обновляй копию
вместе с сервером. Для нового проекта используй arc42-init с profile: product.
Новые validation/document/recover работают с .arc42.yaml. Legacy inventory доступен
до инициализации. Прежние upstream-workspace продолжают работать с шестью исходными
инструментами; их файлы автоматически не преобразуются.
