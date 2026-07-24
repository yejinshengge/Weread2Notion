# WeRead to Notion

Chrome Manifest V3 插件，用于把微信读书书架、阅读进度、划线和想法同步到 Notion 数据库。

## 功能

- 通过微信读书 Agent API Gateway 和个人 API Key 读取数据。
- 在同一个扩展页内完成书籍同步和配置。
- 读取书架、默认全选、手动同步，并配置书籍字段条目。
- 配置页设置 Notion 内部集成密钥、数据库 URL/ID。
- 书名默认写入 Notion 数据库自带的 title 字段。
- 字段条目可选择 Notion 字段、微信读书字段或自定义内容。
- 可将微信读书封面设置为 Notion 页面封面。
- 使用 `WeRead ID` 字段查询已有页面，重复同步时更新而不是重复创建。
- 字段可独立设置是否覆盖更新。
- 每本书只对应一个 Notion 页面，书籍字段写入页面属性，划线与想法写入页面内的托管折叠块。
- 重复同步只替换插件托管的划线折叠块，不会删除页面中的其他手工内容。

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

1. 准备格式为 `wrk-...` 的微信读书个人 API Key。
2. 创建 Notion 内部集成，复制密钥，并把目标数据库授权给该集成。
3. 打开扩展设置页，填写 `WEREAD_API_KEY`。
4. 填写 Notion 密钥和数据库 URL/ID，点击“验证数据库”。
5. 到“书籍同步”页配置字段条目并保存。
6. 点击“读取书架”，勾选要同步的书，再点击“同步书籍与划线”。
7. 同步后，划线与想法会出现在对应书籍页面的“微信读书划线与想法”折叠块中。

## 说明

微信读书读取统一通过 `POST https://i.weread.qq.com/api/agent/gateway` 完成。每次请求都会携带 `skill_version`，业务参数与 `api_name` 同层传递；API Key 仅保存在扩展的本地存储中。
