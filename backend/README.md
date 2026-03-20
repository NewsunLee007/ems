# EMS 后端服务（MariaDB）

## 1) MariaDB 初始化

```bash
mysql -uroot -p < sql/init_mariadb.sql
```

## 2) 配置环境变量

```bash
cp .env.example .env
```

按你的 MariaDB 实际账号修改 `.env`：

- `DB_HOST`
- `DB_PORT`
- `DB_USER`
- `DB_PASSWORD`
- `DB_NAME`
- `ADMIN_USERNAME`
- `ADMIN_PASSWORD`

## 3) 启动

```bash
npm install
npm start
```

默认端口：`3000`

## 提供能力

- `POST /api/save-all` 保存系统完整数据到 MariaDB
- `GET /api/load-latest` 读取最近一次保存数据
- `GET /api/history` 查看历史记录列表
- `GET /api/history/:id` 读取指定历史记录
- `GET /api/download/invigilator.xlsx` 下载监考编排 Excel
- `GET /api/download/seat.xlsx` 下载考场编排 Excel
- `POST /api/auth/login` 登录获取令牌
- `GET /api/auth/me` 获取当前用户
- `GET /api/users` 管理员查看用户清单
- `POST /api/users` 管理员新增用户

系统会在首次启动时自动创建管理员账户（来自 `.env` 的 `ADMIN_USERNAME/ADMIN_PASSWORD`）。

## 网页访问

启动后访问：

`http://localhost:3000/`

页面会自动加载根目录下 `考场编排系统（原始文件） .html`。
