# WeRead to Notion

Chrome Manifest V3 插件，用于把微信读书书架和阅读进度同步到 Notion 数据库。

## 功能

- 读取当前 Chrome 已登录的微信读书网页版会话。
- 在右上角 popup 中读取书架、默认全选、手动同步。
- 在独立设置页配置 Notion 内部集成密钥、数据库 URL/ID、字段映射。
- 书名默认写入 Notion 数据库自带的 title 字段。
- 可选同步封面、阅读进度、作者、URL、阅读状态、WeRead ID。
- 可将微信读书封面设置为 Notion 页面封面。
- 使用 `WeRead ID` 字段查询已有页面，重复同步时更新而不是重复创建。
- 字段可独立设置是否覆盖更新。

## Notion 数据库要求

目标数据库必须包含：

- Notion title 字段：字段名不限，扩展会自动识别并写入书名。
- `WeRead ID`：建议使用 rich text 或 select 字段，用于去重。

可选字段类型：

- 封面：url 或 files。
- 阅读进度：number。
- 作者、WeRead ID：rich text 或 select。
- URL：url 或 rich text。
- 阅读状态：select、status 或 rich text。

如果使用 status 字段，请先在 Notion 中准备好“未开始”“阅读中”“已读完”三个选项。

## 开发

```bash
npm install
npm run build
```

构建后在 Chrome 打开 `chrome://extensions`，启用开发者模式，选择 `dist` 目录加载已解压的扩展。

## 使用

1. 在 Chrome 中登录微信读书网页版。
2. 创建 Notion 内部集成，复制密钥，并把目标数据库授权给该集成。
3. 打开扩展设置页，填写 Notion 密钥和数据库 URL/ID，点击“验证数据库”。
4. 配置字段映射并保存。
5. 打开扩展 popup，点击“读取书架”，勾选要同步的书，点击“同步到 Notion”。

## 说明

微信读书网页接口不是公开稳定 API。本项目把微信读书读取逻辑隔离在 `src/services/weread.ts`，后续若接口变化，只需优先调整这个适配层。