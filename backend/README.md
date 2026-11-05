# 银龄岚途 · 智慧养老 AI 网关（FastAPI）

面向乡村 / 海岛养老场景的最小大模型网关：把前端「AI 健康助手」的提问转发给华为云
MaaS（OpenAI 兼容接口），以 SSE 流式返回答案；P1 增加华为云 IoTDA 实时体征链路
（手环模拟器 → MQTT 上报 → 规则引擎数据转发 → AMQP → SQLite 落库 + WebSocket 推送）。
两条链路**各自独立降级**：未配置 MaaS Key 时回答走本地关键词模板；IoTDA 未配置或中断时
后端保持 Web 服务可用、实时链路静默，前端 WS 重连耗尽后才回退本地模拟，
保证演示环境没有云资源时页面仍可操作。

## 一、目录说明

```text
backend/
├─ app/
│  ├─ __init__.py     # 包声明与版本号
│  ├─ config.py       # 读取 backend/.env；Settings 单例 + llm_enabled / iot_enabled / command_enabled 派生
│  ├─ schemas.py      # Pydantic v2 请求模型与字段校验（422 由 FastAPI 自动返回）
│  ├─ prompts.py      # 中文 system prompt：角色、老人档案、安全边界、免责声明
│  ├─ llm.py          # MaaS 流式调用 + 本地模板降级 + 模拟流式切块
│  ├─ main.py         # FastAPI 应用、CORS、健康检查、SSE 对话、IoT 状态、命令下发、WS /ws、lifespan
│  └─ iot/            # P1 实时体征链路（可整体降级，不影响 AI 问答）
│     ├─ __init__.py
│     ├─ device_simulator.py  # IoTDA MQTT 手环模拟器（属性上报 + 命令应答 + 异常注入）
│     ├─ amqp_consumer.py     # 规则引擎 AMQP 订阅守护线程（依赖 python-qpid-proton）
│     ├─ processor.py         # 阈值判定、告警生成与 60s 冷却、落库、WS 广播
│     ├─ storage.py           # 唯一持久化入口（SQLite 实现，切 GaussDB 只改此文件）
│     └─ ws.py                # WebSocket 连接管理与跨线程广播桥
├─ data/              # 运行时自动创建；iot.db 落库（已被 .gitignore 忽略）
├─ .env.example       # 环境变量模板（含 P0 MaaS 与 P1 IoTDA 两段）
├─ .gitignore         # 忽略 .env / data / *.db / 虚拟环境 / 缓存
├─ requirements.txt   # 依赖清单（P1 新增 paho-mqtt、python-qpid-proton）
└─ README.md          # 本文档
```

各文件职责一句话：

| 文件 | 职责 |
| --- | --- |
| `app/config.py` | 从 `backend/.env` 加载配置，`.env` 路径基于文件位置推导，任意目录启动都能读到；IoT 是否启用由派生属性判断 |
| `app/schemas.py` | 校验对话请求：消息 1-30 条、单条 ≤4000 字、年龄 0-130；另含命令下发模型 `DeviceCommand` |
| `app/prompts.py` | 生成包含老人档案与安全边界的中文 system prompt |
| `app/llm.py` | 优先调用 MaaS 流式接口，失败/无 Key 时用本地模板模拟流式输出 |
| `app/main.py` | 暴露 HTTP / SSE / WebSocket 接口，管理 CORS 与 IoT 资源启停 |
| `app/iot/device_simulator.py` | 用 PC 模拟手环直连 IoTDA MQTT 8883，周期上报体征并接收云端命令 |
| `app/iot/amqp_consumer.py` | 订阅 IoTDA 规则引擎转发的 AMQP 队列，解析消息体后交给 processor |
| `app/iot/processor.py` | `handle_frame()`：落库 → 判阈 → 冷却去重 → 告警落库 → WS 广播 |
| `app/iot/storage.py` | 建表 `init_db()` 与 5 个业务函数（`insert_vitals` / `insert_alert` / `recent_vitals` / `recent_alerts` / `stats`），上层不写 SQL |
| `app/iot/ws.py` | 维护 WS 连接，`publish_threadsafe()` 支持从 AMQP 同步线程安全广播 |

> **P1 带来的环境变量与依赖变化**：`.env.example` 追加了 `IOTDA_*`、`IOTDB_PATH`、
> `HUAWEI_CLOUD_*` 与阈值/冷却配置；`requirements.txt` 追加 `paho-mqtt>=2.1.0`（设备侧 MQTT）
> 与 `python-qpid-proton>=0.39.0`（平台侧 AMQP）。两者缺失只会让 IoT 链路降级，
> AI 问答与前端演示不受影响。

## 二、Windows PowerShell 启动步骤

在 `D:\Desktop\华为开发者项目\backend` 目录下依次执行：

```powershell
# 1. 创建并激活虚拟环境
python -m venv .venv
.\.venv\Scripts\Activate.ps1

# 2. 安装依赖
pip install -r requirements.txt

# 3. 复制环境变量模板并填写 Key
Copy-Item .env.example .env
notepad .env

# 4. 启动服务（开发模式，代码改动自动重载）
uvicorn app.main:app --reload --port 8000
```

> 若 PowerShell 禁止执行脚本，可先运行：
> `Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass`

也可使用模块方式启动（不经过 uvicorn 命令行）：

```powershell
python -m app.main
```

启动后：

- 接口文档：<http://127.0.0.1:8000/docs>
- 健康检查：<http://127.0.0.1:8000/api/health>

## 三、环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `MAAS_API_KEY` | 空 | 华为云 MaaS API Key；为空时 `llm_enabled=false`，走本地模板 |
| `MAAS_MODEL` | `deepseek-v4-flash` | 模型名称，需与 MaaS 控制台开通的一致 |
| `MAAS_BASE_URL` | `https://api.modelarts-maas.com/v2/chat/completions` | OpenAI 兼容的 chat completions 地址 |
| `APP_PORT` | `8000` | `python -m app.main` 启动时监听的端口 |
| `CORS_ORIGINS` | `*` | 允许的来源，多个用英文逗号分隔 |

> `.env` 已被 `.gitignore` 忽略，请勿把密钥提交到仓库；代码中没有任何硬编码密钥。

## 四、接口说明

### 1. 健康检查

```powershell
curl.exe http://127.0.0.1:8000/api/health
```

返回：

```json
{"status":"ok","llm_enabled":false}
```

- 未配置 `MAAS_API_KEY`：`llm_enabled` 为 `false`（当前为本地模板模式）；
- 配置了 Key：`llm_enabled` 为 `true`。

### 2. 流式对话

`POST /api/chat`，`Content-Type: application/json`，响应 `text/event-stream`。

请求体：

```json
{
  "elder": {
    "name": "林阿婆",
    "gender": "女",
    "age": 82,
    "village": "北港村",
    "town": "流水镇",
    "health": "semi",
    "chronic": ["高血压", "2 型糖尿病"],
    "lastVitals": {"hr": 78, "sbp": 152, "dbp": 88, "spo2": 96, "temp": 36.6}
  },
  "messages": [{"role": "user", "content": "最近血压有点高，平时要注意什么？"}],
  "stream": true
}
```

PowerShell 示例（Windows 下务必使用 `curl.exe`，JSON 必须写成一行，内部引号用反引号转义）：

```powershell
curl.exe -N -X POST "http://127.0.0.1:8000/api/chat" `
  -H "Content-Type: application/json" `
  -d "{\"elder\":{\"name\":\"林阿婆\",\"gender\":\"女\",\"age\":82,\"village\":\"北港村\",\"health\":\"semi\",\"chronic\":[\"高血压\"],\"lastVitals\":{\"hr\":78,\"sbp\":152,\"dbp\":88,\"spo2\":96,\"temp\":36.6}},\"messages\":[{\"role\":\"user\",\"content\":\"最近血压有点高，平时要注意什么？\"}],\"stream\":true}"
```

或用 `Invoke-RestMethod`（会一次性取回全部内容，适合功能验证）：

```powershell
$body = @{
  elder    = @{ name = "林阿婆"; gender = "女"; age = 82; village = "北港村"; health = "semi"
                chronic = @("高血压"); lastVitals = @{ hr = 78; sbp = 152; dbp = 88; spo2 = 96; temp = 36.6 } }
  messages = @(@{ role = "user"; content = "最近血压有点高，平时要注意什么？" })
  stream   = $true
} | ConvertTo-Json -Depth 6

Invoke-RestMethod -Uri "http://127.0.0.1:8000/api/chat" -Method Post `
  -ContentType "application/json" -Body ([System.Text.Encoding]::UTF8.GetBytes($body))
```

SSE 事件（每条以空行结束）：

```text
data: {"type":"token","content":"结合林阿婆近 30 天数据，"}

data: {"type":"token","content":"收缩压均值约 152 mmHg"}

data: {"type":"done"}
```

出错时：

```text
data: {"type":"error","message":"模型输出中断，请稍后重试"}
```

说明：

- 服务端统一使用 `json.dumps(..., ensure_ascii=False)`，中文不会被转义；
- 文本中的换行在 JSON 里转义为 `\n`，前端 `JSON.parse` 后可正确还原；
- 响应头包含 `cache-control: no-cache`、`x-accel-buffering: no`，避免代理缓冲。

## 五、降级策略

| 场景 | 行为 |
| --- | --- |
| 未配置 `MAAS_API_KEY` | 直接使用本地关键词模板，模拟流式输出 |
| 上游超时 / 网络异常 / 非 2xx，且**未输出任何 token** | 记录日志，自动切本地模板 |
| 已经输出过 token 后中断 | 只发 `{"type":"error",...}`，避免半截回答拼接模板 |
| 上游流结束但内容为空 | 改用本地模板，避免前端空白 |

本地模板移植自前端 `assets/js/pages/ai.js` 的 `answerFor(q, elder)` 与 `adviceFor(elder)`，
覆盖：急症（胸痛 / 呼吸困难 / 意识障碍 / 偏瘫 / 大出血 / 过敏）、胸闷、血压、心率、
睡眠、饮食、跌倒、血糖、运动、用药、情绪孤独、咳嗽发热食欲，以及通用兜底。
急症场景优先给 120 指引；其余回答末尾统一附「以上建议仅供参考，不能替代医生面诊。」

## 六、常见问题

**1. `401 Unauthorized` / `403 Forbidden`**

- 检查 `.env` 中 `MAAS_API_KEY` 是否填写正确、是否有多余空格或引号；
- 确认 Key 已开通对应模型权限，且所在地域可用；
- 修改 `.env` 后需重启服务（`python-dotenv` 只在进程启动时读取一次）。

**2. 模型名报错（如 `model not found`）**

- `MAAS_MODEL` 必须与 MaaS 控制台「在线推理」中已部署/开通的模型名一致；
- 默认值 `deepseek-v4-flash` 仅作示例，请按实际开通情况修改。

**3. 浏览器报 CORS 错误**

- `.env` 中 `CORS_ORIGINS=*` 时服务端返回 `Access-Control-Allow-Origin: *`，
  此时不允许携带 Cookie（本项目 `allow_credentials=False`，符合规范）；
- 若前端使用固定域名，建议改成精确来源，如
  `CORS_ORIGINS=http://127.0.0.1:5500,http://localhost:5500`；
- 修改后重启服务。

**4. 端口被占用（`[Errno 10048]`）**

```powershell
# 查看占用 8000 端口的进程
Get-NetTCPConnection -LocalPort 8000 -State Listen |
  Select-Object LocalAddress, LocalPort, OwningProcess

# 结束该进程（把 <PID> 换成上一步查到的 OwningProcess）
Stop-Process -Id <PID> -Force
```

或直接换端口启动：`uvicorn app.main:app --reload --port 8001`。

**5. 流式输出“攒一堆才显示”**

- 确认请求经过的 Nginx / 网关没有开启 `proxy_buffering on`；
- 本项目已设置 `x-accel-buffering: no` 与 `cache-control: no-cache`，
  若仍有问题请检查中间代理配置。

**6. PowerShell 下 `curl` 报错**

- Windows PowerShell 中 `curl` 是 `Invoke-WebRequest` 的别名，不支持 `-N` 等参数，
  请使用 `curl.exe`（如本文示例）或 `Invoke-RestMethod`。

## 七、安全说明

- 仓库内无任何硬编码密钥，密钥仅从 `.env` 或系统环境变量读取；
- 调用上游保持默认 SSL 校验，代码中不存在 `verify=False`；
- `.env` 已在 `.gitignore` 中，请勿在截图、日志或提交中出现真实 Key；
- 模型输出仅作健康参考，涉及用药与急症时以医生与急救人员意见为准。

---

# P1：华为云 IoTDA 实时体征链路

> 以下章节只描述 P1 新增能力。P0 的 AI 问答链路（`/api/health`、`/api/chat`）行为不变，
> 两条链路互不阻塞：IoT 全部配置留空时，服务照常启动，前端仍可用内置模拟数据完成演示。

## 八、P1 链路总览

### 1. 数据流

```text
┌──────────────────────────┐
│ 手环模拟器                │  python -m app.iot.device_simulator
│ app/iot/device_simulator  │  每 N 秒生成一帧体征（SIMULATE_INTERVAL，默认 5s）
└────────────┬─────────────┘
             │ MQTT 3.1.1 / TLS :8883
             │ topic: $oc/devices/{设备ID}/sys/properties/report
             │ 鉴权: password = base64(HMAC-SHA256(设备密钥, 毫秒时间戳))
             ▼
┌──────────────────────────┐
│ 华为云 IoTDA 设备接入      │  产品（MQTT / JSON）+ 物模型服务 DefaultService
│ 设备状态：在线 / 属性上报   │  设备收到云端命令后回 ACK
└────────────┬─────────────┘
             │ 规则引擎 → 数据转发（筛选 resource = device.property）
             ▼
┌──────────────────────────┐
│ AMQP 队列（DefaultQueue）  │  amqps://{IOTDA_AMQP_HOST}:5671
│ SASL 接入凭证             │  username=accessKey=..|timestamp=..|instanceId=..
└────────────┬─────────────┘
             │ python-qpid-proton 守护线程（断线按 1/2/4/8/15 秒退避重连）
             ▼
┌──────────────────────────┐
│ app/iot/amqp_consumer.py │  _extract_frame() 解析 notify_data 或扁平 JSON
│   → app/iot/processor.py │  handle_frame(): 落库 → 判阈 → 冷却 → 告警 → 广播
└───────┬──────────┬───────┘
        │          │
        │          └──────────────► WebSocket /ws
        ▼                             （manager.publish_threadsafe 跨线程投递）
┌────────────────┐                          │
│ SQLite         │                          ▼
│ data/iot.db    │                 ┌────────────────────┐
│ vitals / alerts│                 │ 前端 core/realtime │ → 全局告警弹窗
└────────────────┘                 │ .js + app.js/devices│ → 设备详情页日志行
                                   └────────────────────┘
```

一帧数据的三个落点（顺序与 `processor.handle_frame()` 一致）：

1. `storage.insert_vitals()` 写入 `vitals` 表；写失败只记 warning，**不阻断**后续；
2. 阈值判定 + 冷却去重，命中时 `storage.insert_alert()` 写入 `alerts` 表；
3. `manager.publish_threadsafe()` 广播 `{"type":"vitals"}` 与 `{"type":"alert"}`，
   AMQP 线程通过主事件循环把消息送回 `/ws` 连接。

### 2. 逐段职责与降级原则

| 段 | 负责文件 / 组件 | 缺失时的行为 |
| --- | --- | --- |
| 设备上报 | `app/iot/device_simulator.py` → IoTDA MQTT | 模拟器启动前做三项配置检查，缺失时打印中文提示并以退出码 0 退出 |
| 平台转发 | IoTDA 控制台：产品 / 物模型 / 规则引擎 | 规则不命中则队列无消息，后端表现为“连上了但一直安静” |
| 平台订阅 | `app/iot/amqp_consumer.py` | 依赖缺失或 `amqp_enabled=false` 时线程不启动，仅 warning |
| 业务处理 | `app/iot/processor.py` | 单条消息异常只记日志、消息仍 `accept`，不会拖垮消费线程 |
| 持久化 | `app/iot/storage.py` | SQLite 异常只记日志并返回 `False` / 空列表 |
| 推送 | `app/iot/ws.py` + `/ws` | 无客户端时直接跳过广播；单连接失败只剔除该连接 |
| 前端 | `assets/js/core/realtime.js`、`app.js`、`pages/devices.js` | WS 重连 5 次耗尽后回调 `onUnavailable`，回退本地模拟 |

**核心原则：任一段缺失即降级，绝不抛异常阻断服务。** 但要区分「链路降级（后端无新帧）」
与「前端回退模拟」两件事：缺配置、规则不命中、AMQP 断开时 `/ws` 仍然连通，前端只会“没有新帧”，
**不会自动切回模拟**；只有 WS 本身连不上（重连 5 次耗尽）时，`app.js` / `devices.js`
才回退本地模拟。具体矩阵见[十三、降级矩阵](#十三降级矩阵)。

### 3. 阈值与告警规则（与前端 `store.js` 保持一致）

| 指标 | 字段 | 触发条件 | `level=critical` 边界 | 告警 `type` |
| --- | --- | --- | --- | --- |
| 心率 | `hr` | `> 105` 或 `< 50` | `> 115` 或 `< 40` | `hr` |
| 血压 | `sbp` / `dbp` | `sbp > 150` | `sbp >= 180` | `bp` |
| 血氧 | `spo2` | `< 92` | `<= 88` | `spo2` |
| 跌倒 | `fall` | 非 0 | 恒为 critical | `fall` |
| 求助 | `sos` | 非 0 | 恒为 critical | `sos` |

- 数值 `0` 一律视为“该项无记录”，不会误报心率过低 / 血氧过低；
- 冷却键为 `(device_id, type)`，同一设备同一类型在 `IOTDA_ALERT_COOLDOWN` 秒内只报一次
  （默认 60 秒），冷却时间基于帧内 `event_time` 计算；
- 告警 ID 形如 `AL202611050001`（`AL` + 日期 + 4 位当日序号），写入 `alerts.id` 主键。

## 九、华为云控制台配置步骤

> 控制台菜单可能随版本调整，如名称不一致，以实际界面为准；下面按“从实例到队列”的顺序排列，
> 每一步都可独立核对。以下操作在**华为云控制台**完成，不在本地代码里完成。

### 步骤 1：创建 IoTDA 实例，记录三个接入地址

1. 登录华为云控制台，搜索并进入 **设备接入 IoTDA**；
2. 选择 **购买实例**（标准版即可满足演示；企业版需额外记录实例 ID），按提示完成购买；
3. 进入实例详情 / **总览** 页，找到 **接入信息**，记录三项：
   - **实例 ID**（企业版必填，填入 `IOTDA_INSTANCE_ID`）；
   - **MQTT 接入地址 / 设备接入域名**：形如
     `xxxxxxxx.st1.iotda-device.cn-north-4.myhuaweicloud.com`，端口 `8883`；
   - **AMQP 接入地址**：形如 `xxxxxxxx.iot-amqp.cn-north-4.myhuaweicloud.com`，端口 `5671`。

   对应写入 `.env`：`IOTDA_MQTT_HOST`、`IOTDA_MQTT_PORT=8883`、
   `IOTDA_AMQP_HOST`、`IOTDA_AMQP_PORT=5671`。

### 步骤 2：创建产品

1. 左侧 **产品** → **创建产品**；
2. 按下表填写表单字段：

   | 表单字段 | 填写值 | 说明 |
   | --- | --- | --- |
   | 产品名称 | 银龄守护手环 | 任意，便于识别 |
   | 协议类型 | **MQTT** | 模拟器使用 MQTT 3.1.1 |
   | 数据格式 | **JSON** | 上报报文为 JSON 对象 |
   | 设备类型 | **智能手环** | 可穿戴设备 |
   | 厂商名称 / 型号 | 可选 | 不影响链路 |

3. 创建完成后进入产品详情，后续物模型都挂在该产品下。

### 步骤 3：定义物模型（服务 ID 必须与代码一致）

1. 产品详情 → **模型定义** → **添加服务**；
2. **服务 ID** 填 `DefaultService`（代码常量 `DEFAULT_SERVICE_ID` 的默认值；
   若改成其他名字，必须同步设置 `IOTDA_SERVICE_ID`，否则平台按“服务不存在”丢弃整帧）；
3. 服务类型可选“传感器”，然后逐个 **添加属性**：

   | 属性名称 | 属性编码（JSON 字段） | 数据类型 | 访问方式 | 单位建议 | 说明 |
   | --- | --- | --- | --- | --- | --- |
   | 心率 | `hr` | int | 可读 | bpm | 静息心率 |
   | 收缩压 | `sbp` | int | 可读 | mmHg | 高压 |
   | 舒张压 | `dbp` | int | 可读 | mmHg | 低压 |
   | 血氧饱和度 | `spo2` | int | 可读 | % | 取值范围 0-100 |
   | 步数 | `steps` | int | 可读 | 步 | 单调累计 |
   | 电量 | `battery` | int | 可读 | % | 0-100 |
   | 跌倒 | `fall` | int | 可读 | 次 | 0 无、1 检测到 |
   | 求助 | `sos` | int | 可读 | 次 | 0 无、1 触发 SOS |

   > 演示设备只上报，不接收属性配置，因此访问方式勾“可读”即可。
   > 属性编码必须与上表完全一致——`amqp_consumer` 虽然兼容
   > `heart_rate` / `systolic` / `oxygen` 等别名，但规则 SQL 与设备上报以产品模型为准。

4. 如需验证云端命令下发，可在同一服务下 **添加命令** `restart`（下发参数可留空），
   与 `POST /api/device/command` 的默认 `command_name` 对应。

### 步骤 4：注册设备（密钥认证）

1. 左侧 **设备** → **注册设备**；
2. 按下表填写：

   | 表单字段 | 填写值 | 说明 |
   | --- | --- | --- |
   | 所属产品 | 银龄守护手环 | 步骤 2 创建的产品 |
   | 设备标识码 | 如 `bracelet_E01` | 自定义，便于人工识别 |
   | 认证类型 | **密钥** | 对应代码的 HMAC-SHA256 鉴权 |
   | 设备密钥 | 自定义或自动生成 | **只显示一次，立即保存** |

3. 注册完成后在设备列表复制 **设备 ID**（平台生成的唯一标识，**不是**设备标识码），
   与设备密钥一起写入 `.env`：

   ```dotenv
   IOTDA_DEVICE_ID=控制台上的设备ID
   IOTDA_DEVICE_SECRET=注册时保存的设备密钥
   ```

4. 新注册设备状态为“未激活”；模拟器首次 MQTT 连接成功后变为“在线”。

### 步骤 5：规则引擎 → 数据转发 → 新建 AMQP 目标

1. 左侧 **规则** → **数据转发** → **创建规则**；
2. 基本信息：规则名称如 `iot-to-amqp`，启用规则；
3. **数据来源**：选择“设备属性上报”（即设备上报属性时触发）；
4. **筛选条件**：填写 `resource = device.property`
   （部分界面为 SQL 形式 `SELECT * FROM device.property`，以实际界面为准）；
5. **转发目标** 选择 **AMQP**，然后按下述顺序准备队列与凭证：

   **5.1 创建队列**：在 AMQP / 消息队列页面 **创建队列**，队列名填 `DefaultQueue`
   （与 `.env` 的 `IOTDA_AMQP_QUEUE` 一致）。

   **5.2 创建接入凭证**：在 AMQP 接入信息页 **创建接入凭证**，得到：

   | 凭证字段 | 写入 `.env` | 说明 |
   | --- | --- | --- |
   | AccessKey | `IOTDA_AMQP_ACCESS_KEY` | 用户名的一部分 |
   | AccessCode | `IOTDA_AMQP_ACCESS_CODE` | SASL 密码，只显示一次 |

   写入后形如：

   ```dotenv
   IOTDA_AMQP_HOST=控制台给出的AMQP接入地址
   IOTDA_AMQP_PORT=5671
   IOTDA_AMQP_ACCESS_KEY=控制台生成的AccessKey
   IOTDA_AMQP_ACCESS_CODE=控制台生成的AccessCode
   IOTDA_AMQP_QUEUE=DefaultQueue
   IOTDA_INSTANCE_ID=企业版实例ID（标准版按控制台接入信息填写）
   ```

6. 回到规则页，转发目标选择刚创建的队列 `DefaultQueue`，保存并 **启用规则**；
7. 模拟器上报后，可在规则页查看转发记录；后端日志应出现
   `AMQP 已连接，开始消费队列 DefaultQueue` 与 `AMQP 收到消息（queue=DefaultQueue）`。

> 说明：代码里 AMQP 用户名由 `_build_username()` 拼成
> `accessKey=..|timestamp=..|instanceId=..`，时间戳每次建连重新生成，
> 因此接入凭证过期后无需手工重启，重连会自动换新时间戳。
> 请在创建凭证时确认其有效期覆盖演示时段。

## 十、`.env` 配置逐项说明

在 `backend` 目录执行 `Copy-Item .env.example .env` 后按需填写；**全部留空 = 后端不启动 IoT 订阅**
（即“无云资源”演示模式：AI 问答可用，前端展示内置模拟数据，但不会有新的实时帧）。

### 1. P0（AI 问答，沿用原有配置）

| 变量名 | 示例 | 是否必填 | 说明 |
| --- | --- | --- | --- |
| `MAAS_API_KEY` | `sk-****` | 否 | 为空时 `llm_enabled=false`，回答走本地模板 |
| `MAAS_MODEL` | `deepseek-v4-flash` | 否 | 需与 MaaS 控制台已开通模型一致 |
| `MAAS_BASE_URL` | `https://api.modelarts-maas.com/v2/chat/completions` | 否 | OpenAI 兼容地址 |
| `APP_PORT` | `8000` | 否 | `python -m app.main` 的监听端口 |
| `CORS_ORIGINS` | `*` | 否 | 逗号分隔；`*` 时强制 `allow_credentials=False` |

### 2. P1（IoTDA 设备侧 MQTT）

| 变量名 | 示例 | 是否必填 | 说明 |
| --- | --- | --- | --- |
| `IOTDA_MQTT_HOST` | `xxxxxxxx.st1.iotda-device.cn-north-4.myhuaweicloud.com` | 模拟器必填 | 实例「接入信息」中的设备接入域名 |
| `IOTDA_MQTT_PORT` | `8883` | 否 | 默认 8883；TLS 端口，代码走 `tls_set()` |
| `IOTDA_DEVICE_ID` | `65f1c2...`（平台生成） | 模拟器必填 | 同时作为 MQTT 的 client_id / username，也是告警帧缺 `device_id` 时的兜底 |
| `IOTDA_DEVICE_SECRET` | `******` | 模拟器必填 | 设备密钥，用于 HMAC-SHA256 现算密码 |

> `mqtt_enabled` 要求以上 **HOST / DEVICE_ID / DEVICE_SECRET 三者非空**，否则模拟器拒绝启动。

### 3. P1（IoTDA 平台侧 AMQP）

| 变量名 | 示例 | 是否必填 | 说明 |
| --- | --- | --- | --- |
| `IOTDA_AMQP_HOST` | `xxxxxxxx.iot-amqp.cn-north-4.myhuaweicloud.com` | 接收数据必填 | 实例「接入信息」中的 AMQP 地址 |
| `IOTDA_AMQP_PORT` | `5671` | 否 | 默认 5671（TLS） |
| `IOTDA_AMQP_ACCESS_KEY` | `******` | 接收数据必填 | 接入凭证 AccessKey |
| `IOTDA_AMQP_ACCESS_CODE` | `******` | 接收数据必填 | 接入凭证 AccessCode（SASL 密码） |
| `IOTDA_AMQP_QUEUE` | `DefaultQueue` | 否 | 转发目标队列名，需与控制台一致 |
| `IOTDA_INSTANCE_ID` | `xxxxxxxx` | 企业版必填 | 拼进 SASL 用户名；标准版按控制台信息填写，鉴权失败时优先补齐 |

> `amqp_enabled` 要求 **HOST / ACCESS_KEY / ACCESS_CODE 三者非空**；
> `iot_enabled = mqtt_enabled and amqp_enabled`，即只有设备侧与平台侧同时就绪才算“完整链路”。

### 4. P1（本地落库与展示映射）

| 变量名 | 示例 | 是否必填 | 说明 |
| --- | --- | --- | --- |
| `IOTDB_PATH` | `data/iot.db` | 否 | 相对路径按 `backend/` 解析；留空默认 `data/iot.db`；上层启动时自动建目录与表 |
| `IOTDA_ELDER_ID` | `E01` | 否 | 告警对象 `elderId`，默认 `E01` |
| `IOTDA_ELDER_NAME` | `张桂芳` | 否 | 告警弹窗展示的 `elderName` |

### 5. P1（阈值与冷却，`processor.py` 直接读环境变量）

| 变量名 | 示例 | 是否必填 | 说明 |
| --- | --- | --- | --- |
| `IOTDA_HR_HIGH` | `105` | 否 | 心率上限，超过即告警 |
| `IOTDA_HR_LOW` | `50` | 否 | 心率下限 |
| `IOTDA_SPO2_LOW` | `92` | 否 | 血氧下限 |
| `IOTDA_SBP_HIGH` | `150` | 否 | 收缩压上限 |
| `IOTDA_ALERT_COOLDOWN` | `60` | 否 | 同设备同类型告警冷却秒数 |

> 阈值改动必须与前端 `assets/js/core/store.js` 的 `DEFAULT_THRESHOLDS` 同步，
> 否则会出现“后端报警、前端不亮”或相反的错位。

### 6. P1（云端命令下发，四者齐备才启用）

| 变量名 | 示例 | 是否必填 | 说明 |
| --- | --- | --- | --- |
| `IOTDA_REGION` | `cn-north-4` | 命令下发必填 | 用于拼 IAM 与 IoTDA 域名 |
| `IOTDA_PROJECT_ID` | `xxxxxxxx` | 命令下发必填 | 项目 ID（控制台「我的凭证」） |
| `HUAWEI_CLOUD_AK` | `******` | 命令下发必填 | 仅用于 IAM 换 token |
| `HUAWEI_CLOUD_SK` | `******` | 命令下发必填 | 仅用于 IAM 换 token |

> `command_enabled` 要求以上四项全部非空；缺任意一项时
> `POST /api/device/command` 返回 **503** `CLOUD_COMMAND_DISABLED`。

### 7. P1（模拟器专属变量，不进入 Settings）

| 变量名 | 示例 | 是否必填 | 说明 |
| --- | --- | --- | --- |
| `SIMULATE_INTERVAL` | `5` | 否 | 上报间隔秒数，默认 5，可被 `--interval` 覆盖 |
| `SIMULATE_EVENT` | `hr` | 否 | 注入一次异常，取值 `hr` / `spo2` / `bp` / `fall` / `sos`，可被 `--event` 覆盖 |
| `IOTDA_SERVICE_ID` | `DefaultService` | 否 | 上报报文里的 `service_id`，必须与产品模型一致 |

> 注意：`IOTDA_HR_HIGH` 等阈值与 `SIMULATE_*` **不在** `Settings` 中，
> 前者由 `processor.py` 用 `os.getenv` 直读，后者由模拟器 `os.getenv` 直读；
> 修改后需重启对应进程才生效。

## 十一、启动顺序（模拟器 → 后端 → 前端）

三个进程职责不同，**必须按此顺序启动**：模拟器先上线并开始上报，后端启动后即可持续收到后续帧；
后端先就绪，前端打开时 `/ws` 才能握手成功。

```text
① 设备模拟器（独立窗口，常驻）  →  ② 后端 FastAPI（独立窗口，常驻）  →  ③ 浏览器打开 index.html
   持续向 IoTDA 上报体征             订阅 AMQP、落库、广播 /ws              连接 /ws、渲染弹窗与日志
```

### ① 启动模拟器

新开一个 PowerShell 窗口，同样进入 `backend` 并激活虚拟环境：

```powershell
cd D:\Desktop\华为开发者项目\backend
.\.venv\Scripts\Activate.ps1
python -m app.iot.device_simulator
```

启动前会自检 `IOTDA_MQTT_HOST` / `IOTDA_DEVICE_ID` / `IOTDA_DEVICE_SECRET`，
缺任一则打印中文提示并退出（退出码 0，不抛异常栈）。连接成功后日志形如：

```text
[22:15:01] [连接] CONNACK rc=0 鉴权通过，连接成功
[22:15:01] [订阅] 已订阅命令 topic：$oc/devices/<设备ID>/sys/commands/#
[22:15:02] [上报 #1] hr=72 sbp=124 dbp=77 spo2=97 steps=1210 battery=86 fall=0 sos=0 (mid=1)
```

常用参数：

| 参数 / 环境变量 | 作用 | 示例 |
| --- | --- | --- |
| `--event <类型>` | 启动后注入一次异常，仅影响一帧；类型 `hr` / `spo2` / `bp` / `fall` / `sos` | `--event hr` |
| `--event-after <秒>` | 启动后第 N 秒注入，默认 10 秒 | `--event hr --event-after 5` |
| `--once` | 连接成功后立即上报一帧并退出（便于单次验证） | `--event sos --once` |
| `--interval <秒>` | 上报间隔，默认 5 秒 | `--interval 2` |
| `SIMULATE_EVENT` | 等价于 `--event`，命令行优先 | `$env:SIMULATE_EVENT='spo2'` |
| `SIMULATE_INTERVAL` | 等价于 `--interval`，默认 5 | `$env:SIMULATE_INTERVAL='2'` |
| `IOTDA_SERVICE_ID` | 上报报文 `service_id`，默认 `DefaultService` | `$env:IOTDA_SERVICE_ID='DefaultService'` |

示例：

```powershell
# 常驻上报，每 5 秒一帧
python -m app.iot.device_simulator

# 启动 10 秒后注入一次心率异常，之后自动恢复正常
python -m app.iot.device_simulator --event hr --event-after 10

# 单帧跌倒异常后立即退出，用于快速验证链路
python -m app.iot.device_simulator --event fall --once
```

> 断线后模拟器按 1→2→4→8→16 秒退避自动重连，最长持续 15 分钟；
> `--once` 模式不重试，10 秒内未收到 CONNACK 即退出并返回 1。

### ② 启动后端

另开一个 PowerShell 窗口：

```powershell
cd D:\Desktop\华为开发者项目\backend
.\.venv\Scripts\Activate.ps1

# 常规启动（演示 / 部署用）
uvicorn app.main:app --port 8000

# 开发时可加 --reload，改代码自动重载
uvicorn app.main:app --reload --port 8000
```

启动日志会打印关键开关（`llm_enabled` / `iot_enabled` / `command_enabled`），便于确认降级状态：

```text
银龄岚途 AI 网关启动：llm_enabled=false，model=deepseek-v4-flash，iot_enabled=true，command_enabled=false
IoT 本地库就绪：...\backend\data\iot.db
IoTDA AMQP 消费线程已启动（queue=DefaultQueue，host=...）
AMQP 已连接，开始消费队列 DefaultQueue
```

若出现 `未配置 IoTDA AMQP，退回本地模拟模式`，说明 `amqp_enabled` 与 `iot_enabled` 都为假。

### ③ 打开前端

直接在资源管理器中双击项目根目录的 `index.html`（`file://` 方式即可，无需起静态服务器）。

- 前端 API 基址硬编码为 `http://localhost:8000`（`assets/js/core/api.js` 的 `API_BASE`）；
- WebSocket 地址由同一基址推导：`http` → `ws`，即 `ws://localhost:8000/ws`；
- 因此后端**必须监听 8000 端口**；若改用其他端口，需同步修改 `API_BASE`（本任务未改动前端）。

打开后：

- 停留在任意页面都能收到全局告警弹窗（`app.js` 统一订阅 `onAlert`）；
- 进入「设备详情」页，设备编号与上报 `device_id` 匹配时可看到实时上报日志行
  （不匹配时的现象与原因见[十二、验证方法](#十二验证方法powershell逐条可粘贴)第 4 节）。

## 十二、验证方法（PowerShell，逐条可粘贴）

> 以下命令均在 `backend` 目录、已激活 `.venv` 的前提下执行。
> 建议顺序：状态 → WS → SQLite → 异常注入 → 冷却。

### 1. 查看链路状态

```powershell
curl.exe http://127.0.0.1:8000/api/iot/status
```

期望返回（数值随运行时间变化）：

```json
{
  "iot_enabled": true,
  "mqtt_enabled": true,
  "amqp_enabled": true,
  "command_enabled": false,
  "device_id": "65f1c2xxxxxxxxxxxxxxxxxxxx",
  "vitals_count": 128,
  "vitols_count": 128,
  "alerts_count": 3
}
```

| 字段 | 含义 |
| --- | --- |
| `iot_enabled` | `mqtt_enabled and amqp_enabled`，完整链路是否就绪 |
| `mqtt_enabled` | MQTT 三项（HOST / DEVICE_ID / SECRET）是否齐备 |
| `amqp_enabled` | AMQP 三项（HOST / ACCESS_KEY / ACCESS_CODE）是否齐备 |
| `command_enabled` | region / project_id / AK / SK 四项是否齐备 |
| `device_id` | 当前配置的设备 ID（用于前端标注，不含密钥） |
| `vitals_count` | `vitals` 表累计行数（每帧 +1） |
| `vitols_count` | 早期前端字段拼写的兼容别名，与 `vitals_count` 同值 |
| `alerts_count` | `alerts` 表累计行数（冷却挡下的不计入） |

> 该接口**只返回布尔标志、计数值与 `device_id`**，不会返回 device secret / AK / SK / AccessCode。

### 2. 观察 WebSocket 帧

**方式 A（推荐，无需额外依赖）——浏览器控制台：**

1. 双击打开 `index.html`，按 `F12` → Console；
2. 粘贴：

   ```js
   const ws = new WebSocket('ws://127.0.0.1:8000/ws');
   ws.onopen = () => console.log('[WS] open');
   ws.onmessage = (e) => console.log('[WS]', e.data);
   ws.onclose = (e) => console.log('[WS] close', e.code, e.reason);
   ```

3. 期望首帧为握手包，随后每 5 秒一帧体征：

   ```text
   [WS] {"type":"hello","data":{"iot_enabled":true,"time":"2026-11-05 22:20:31"}}
   [WS] {"type":"vitals","data":{"device_id":"65f1...","hr":74,"sbp":123,"dbp":76,"spo2":97,"steps":1240,"battery":86,"fall":0,"sos":0,"event_time":1762345231000}}
   [WS] {"type":"alert","data":{"id":"AL202611050001","time":"2026-11-05 22:21:02","event_time":1762345262000,"deviceId":"65f1...","elderId":"E01","elderName":"张桂芳","type":"hr","level":"critical","metric":"118 bpm","status":"pending","handler":"","source":"iotda"}}
   ```

**方式 B——Python 客户端（需额外安装，`requirements.txt` 未包含）：**

```powershell
pip install "websockets>=12"
python -c "from websockets.sync.client import connect; ws=connect('ws://127.0.0.1:8000/ws'); [print(ws.recv()) for _ in range(5)]; ws.close()"
```

> 若安装失败或版本过低，直接用方式 A。

### 3. 查询 SQLite 落库

```powershell
# 最简写法（看全部列）
sqlite3 data/iot.db "select * from vitals order by id desc limit 5;"
sqlite3 data/iot.db "select * from alerts order by event_time desc limit 5;"

# 只看关键列（输出更清爽）
sqlite3 data/iot.db "select id, device_id, hr, sbp, dbp, spo2, steps, battery, fall, sos, event_time from vitals order by id desc limit 5;"
sqlite3 data/iot.db "select id, device_id, type, level, metric, status, event_time from alerts order by event_time desc limit 5;"
```

`vitals` 表列：`id / device_id / hr / sbp / dbp / spo2 / steps / battery / fall / sos / event_time`
（`event_time` 为毫秒时间戳）；`alerts` 表额外有 `elder_id` 与完整 JSON 的 `payload`。

若系统未安装 `sqlite3` 命令行，可用标准库替代：

```powershell
python -c "import sqlite3; c=sqlite3.connect('data/iot.db'); [print(r) for r in c.execute('select id,device_id,hr,spo2,fall,sos,event_time from vitals order by id desc limit 5')]"
python -c "import sqlite3; c=sqlite3.connect('data/iot.db'); [print(r) for r in c.execute('select id,type,level,metric,status from alerts order by event_time desc limit 5')]"
```

### 4. 注入异常，验证弹窗与详情页

```powershell
# 单帧 SOS（critical，不受冷却影响首次必报）
python -m app.iot.device_simulator --event sos --once

# 单帧心率异常（118-130 bpm，高于阈值 105）
python -m app.iot.device_simulator --event hr --once
```

预期现象：

| 位置 | 预期 |
| --- | --- |
| 模拟器窗口 | `[上报] 已收到平台 QoS1 PUBACK，数据送达 IoTDA.` |
| 后端窗口 | `AMQP 收到消息（queue=DefaultQueue）`；前端已连接时还会先打印 `WebSocket 连接建立` |
| `/api/iot/status` | `vitals_count` +1；首次异常时 `alerts_count` +1 |
| 前端任意页面 | 弹出告警浮窗，标题按 `type` 显示“跌倒 / SOS / 心率异常”等，级别为 critical 时有提示音 |
| 设备详情页 | 仅当页面设备的编号与上报 `device_id` **一致（忽略大小写）** 时才追加一行日志 |

> **关于设备详情页的已知边界**：`assets/js/pages/devices.js` 的 `handleVitals()`
> 会把 `data.device_id` 与当前详情页设备编号（演示数据为 `V01` 等）比较，不一致就忽略。
> IoTDA 的设备 ID 由平台生成，通常不会等于前端演示编号，因此“云端帧不进详情页表格”
> 属于前端过滤逻辑，不是链路故障；全局告警弹窗不依赖该编号（后端告警自带 `elderId`）。
> 若要让详情页也刷新，可把前端设备编号与云端 `device_id` 对齐，或在
> `realtime.js` 的 `DEVICE_ELDER_MAP` 中登记真实设备 ID（该映射仅做编号→老人维度转换）。

### 5. 验证 60 秒告警冷却

同一设备同一 `type` 在 `IOTDA_ALERT_COOLDOWN` 秒内只产生一条告警。可复现步骤：

```powershell
# 1) 记录起点（关注 alerts_count 与 vitals_count）
curl.exe http://127.0.0.1:8000/api/iot/status

# 2) 第一次心率异常：vitals_count +1，alerts_count +1
python -m app.iot.device_simulator --event hr --once

# 3) 60 秒内立刻再来一次：vitals_count 再 +1，alerts_count 不变
python -m app.iot.device_simulator --event hr --once

# 4) 再查一次确认
curl.exe http://127.0.0.1:8000/api/iot/status
```

预期：第 2 步后 `alerts_count = N+1`，第 3 步后仍为 `N+1`（只 `vitals_count` 增加）。
等待超过 60 秒再执行一次，`alerts_count` 才会继续增长。

> 冷却表是**后端进程内**内存（`processor._last_alert`），重启后端即清空；
> 冷却时间以帧内 `event_time` 计算，因此用历史时间戳回放数据时可能被判定为“已冷却”。
> 若只想重置演示状态，重启后端最稳妥（`reset_cooldown()` 未暴露为接口）。

### 6. 命令下发接口（可选）

```powershell
curl.exe -i -X POST "http://127.0.0.1:8000/api/device/command" `
  -H "Content-Type: application/json" `
  -d "{\"device_id\":\"控制台上的设备ID\",\"command_name\":\"restart\",\"service_id\":\"DefaultService\",\"paras\":{}}"
```

- 未配置 `IOTDA_REGION` / `IOTDA_PROJECT_ID` / `HUAWEI_CLOUD_AK` / `HUAWEI_CLOUD_SK`：
  返回 **503**，响应体 `{"code":"CLOUD_COMMAND_DISABLED","enabled":false,"detail":"未启用云端命令下发"}`；
- 配置完整且云端受理：返回 `200`，响应体 `{"ok":true,"response":{...}}`；
- 配置完整但上游失败：返回 **502** `CLOUD_COMMAND_FAILED`，`detail` 为中文提示
  （上游 HTTP 错误会带状态码）。

> 请求体字段见 `app/schemas.py` 的 `DeviceCommand`：`device_id` 必填，
> `command_name` 默认 `restart`，`service_id` 默认 `DefaultService`，`paras` 默认 `{}`。
> 该接口需要设备在线并在物模型中定义对应命令，仅配置 AK/SK 不会让设备真正执行。

## 十三、降级矩阵

下表对照代码真实逻辑（`config.py` 派生属性、`main.lifespan`、`amqp_consumer`、
`realtime.js`、`app.js`、`devices.js`）：

| 场景 | 配置 / 状态 | `/api/iot/status` | 后端行为 | 前端现象 |
| --- | --- | --- | --- | --- |
| 未配置任何 IoTDA 项 | `IOTDA_*` 全空 | 四项全 `false` | 不启动 AMQP 线程，日志 `未配置 IoTDA AMQP，退回本地模拟模式`；模拟器拒绝启动；SQLite 仍建库 | WS 可连、只收到 `hello`（`iot_enabled=false`）；无 `vitals` / `alert` 帧，因此**没有新弹窗**（告警列表仍显示内置历史数据）；不会自动跑模拟 |
| 只配设备侧 MQTT | `mqtt_enabled=true`、`amqp_enabled=false` | `iot_enabled=false` | 仍不启动 AMQP 订阅（条件为 `amqp_enabled or iot_enabled`）；模拟器能连上云、上报成功，但后端收不到 | 同“未配置”：页面无新帧、无新弹窗；云端控制台可见设备在线与属性数据 |
| 只配平台侧 AMQP | `amqp_enabled=true`、`mqtt_enabled=false` | `iot_enabled=false` | AMQP 线程**会启动**（`amqp_enabled` 为真）；有真实设备上报时仍能收帧、落库、广播 | 若队列有数据则出现真实弹窗与日志；`hello.iot_enabled=false` 仅表示“设备侧配置不全” |
| AMQP 断开 / 凭证过期 | 配置项仍非空，`amqp_enabled=true` | 仍显示 `true`（接口只看配置） | 线程按 1/2/4/8/15 秒退避重连，日志 `AMQP 连接已断开（queue=DefaultQueue），将按退避策略重连`；期间无新帧 | WS 仍连接，**不会**自动切回模拟；页面数据停在最后一帧 |
| 规则未命中 / 服务 ID 不匹配 | AMQP 已连接 | 仍显示 `true` | 日志有“已连接”，但无 `AMQP 收到消息`；队列安静 | 页面无新数据，容易误判为“后端坏了”，需按 FAQ 排查 |
| WS 断开（后端停机 / 端口不通） | — | 无法访问 | 后端无影响（若只是前端网络问题） | `realtime.js` 按 1/2/4/8/16 秒重连 5 次；耗尽后回调 `onUnavailable`，控制台打印一次回退提示，`app.js` 在总览 / 告警中心页启动 20 秒定时（60 秒节流）模拟告警，详情页回退 5 秒模拟日志 |
| 模拟器断开 | MQTT 侧断开 | `mqtt_enabled` 仍 `true` | 后端 AMQP 连接保持，只是无新帧；模拟器自身 15 分钟内自动重连 | 页面无新帧；已渲染的弹窗与日志保留 |
| SQLite 不可写 | 目录只读 / 文件被独占 | `vitals_count` 不增长 | `init_db` 或写入失败只记 error，服务与 WS 广播继续工作 | 弹窗与实时日志仍正常（来自 WS），但刷新后历史数据缺失 |

## 十四、切换 GaussDB 说明

### 1. 只需替换一个文件

`app/iot/storage.py` 是**唯一**接触 SQL 的模块，`processor.py` 与 `main.py` 只调用它的函数，
因此切换到 GaussDB 时**不需要改** `processor.py` / `main.py` / `ws.py` / 前端任何代码。

需要保持同名、同语义的 **5 个业务函数**与 1 个建库函数：

```python
# —— 5 个业务函数：processor.py / main.py 只调用这些 ——
def insert_vitals(frame: Dict[str, Any]) -> bool:                           # 写一帧体征
def insert_alert(alert: Dict[str, Any]) -> bool:                            # 写一条告警（同 id 幂等覆盖）
def recent_vitals(device_id: str, limit: int = 20) -> List[Dict[str, Any]]  # 按时间倒序
def recent_alerts(limit: int = 20) -> List[Dict[str, Any]]                  # 结构与前端告警对象一致
def stats() -> Dict[str, Any]                                               # vitals_count / alerts_count / pending_alerts_count

# —— 建库函数：lifespan 启动时调用一次 ——
def init_db() -> bool                                                       # 建目录/建表，失败返回 False
```

### 2. 必须遵守的实现契约（否则上层会出问题）

| 契约 | 要求 | 原因 |
| --- | --- | --- |
| 异常不外抛 | 所有数据库异常只记日志，返回 `False` / `[]` / 零值统计 | AMQP 消费线程与 WS 广播链路不能被数据库拖垮 |
| `insert_vitals` 字段容错 | 缺字段按 `0`，`event_time` 缺失取当前毫秒 | 设备上报可能缺项，processor 以 `0` 表示“无记录” |
| `insert_alert` 幂等 | 同 `id` 重复写入应覆盖而非报错 | 现有实现用 `INSERT OR REPLACE`；GaussDB 用 upsert 等价实现 |
| `event_time` 单位 | 毫秒 `BIGINT` | 与 processor / 前端约定一致，勿存秒或 `DATETIME` |
| `recent_vitals` 返回键 | `device_id / hr / sbp / dbp / spo2 / steps / battery / fall / sos / event_time` | 前端复用同一套渲染逻辑 |
| `recent_alerts` 返回对象 | 列字段 + `payload` 展开 + 补齐 `elderName` / `handler` / `source` | 前端弹窗依赖这些展示字段 |
| `stats` 键名 | `vitals_count` / `alerts_count` / `pending_alerts_count` | `/api/iot/status` 直接取用 |

### 3. 建表 DDL 迁移思路（GaussDB(for MySQL) 示例）

```sql
CREATE TABLE IF NOT EXISTS vitals (
    id         BIGINT       NOT NULL AUTO_INCREMENT,
    device_id  VARCHAR(64)  NOT NULL DEFAULT '',
    hr         INT          DEFAULT 0,
    sbp        INT          DEFAULT 0,
    dbp        INT          DEFAULT 0,
    spo2       INT          DEFAULT 0,
    steps      INT          DEFAULT 0,
    battery    INT          DEFAULT 0,
    fall       INT          DEFAULT 0,
    sos        INT          DEFAULT 0,
    event_time BIGINT       NOT NULL,
    PRIMARY KEY (id),
    KEY idx_vitals_event_time (event_time),
    KEY idx_vitals_device_time (device_id, event_time)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

CREATE TABLE IF NOT EXISTS alerts (
    id         VARCHAR(32)  NOT NULL,
    device_id  VARCHAR(64)  DEFAULT '',
    elder_id   VARCHAR(32)  DEFAULT '',
    type       VARCHAR(16)  DEFAULT '',
    level      VARCHAR(16)  DEFAULT 'normal',
    metric     VARCHAR(64)  DEFAULT '',
    event_time BIGINT       NOT NULL,
    status     VARCHAR(16)  DEFAULT 'pending',
    payload    LONGTEXT,                -- 或按实例版本改用 JSON 类型
    PRIMARY KEY (id),
    KEY idx_alerts_event_time (event_time)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;
```

迁移步骤：

1. 在 GaussDB 实例中执行上述 DDL（`payload` 用 `LONGTEXT` 最稳，避免 JSON 类型版本差异）；
2. 改写 `storage.py`：把 `sqlite3.connect()` 换成连接池（如 `pymysql` / `psycopg2`），
   `INSERT OR REPLACE` 改为 `INSERT ... ON DUPLICATE KEY UPDATE`（MySQL 系）
   或 `MERGE INTO` / `INSERT ... ON CONFLICT`（PostgreSQL 系，按实例引擎选择）；
3. 保留 `_to_int()` / `_format_time()` 等纯函数不变，减少行为差异；
4. 用同一套验证命令回归：`/api/iot/status` 计数、`/ws` 帧、异常注入、60 秒冷却；
5. 历史数据迁移按 `event_time` 升序批量导入，避免主键冲突。

> 若改用 GaussDB(for Influx) / 时序库，`recent_vitals` 的排序分页语义与 `payload` 结构差异较大，
> 仍建议保留 `storage.py` 的 5 个函数签名，只替换内部实现，上层零改动。

## 十五、排障 FAQ

**1. 控制台设备一直显示“未激活 / 离线”**

- “未激活”表示设备从未成功建连：先看模拟器窗口是否有 `CONNACK rc=0`；
- 核对 `IOTDA_DEVICE_ID` 填的是设备列表里的 **设备 ID**，不是注册时填的“设备标识码”；
- 核对产品协议为 MQTT、数据格式 JSON；
- 企业版实例需确认 `IOTDA_INSTANCE_ID` 与接入域名同属一个实例；
- 若模拟器报 `rc=4`（用户名或密码错误），见下一条。

**2. MQTT 鉴权失败（CONNACK rc=1 ~ rc=5）**

代码已内置中文提示（`CONNECT_HINTS`）：

| rc | 含义 | 排查 |
| --- | --- | --- |
| 1 | 协议版本不被接受 | 必须 MQTT 3.1.1（代码已固定 `MQTTv311`） |
| 2 | clientId 被拒绝 | `IOTDA_DEVICE_ID` 不是平台设备 ID |
| 3 | 服务端不可用 | 域名 / 8883 端口不可达，检查网络与实例状态 |
| 4 | 用户名或密码错误 | `IOTDA_DEVICE_SECRET` 错误，或密钥已被重置 |
| 5 | 未授权 | 设备被冻结 / 删除，去控制台确认状态 |

> 密码不是固定值：每次连接都用当前毫秒时间戳现算 `base64(HMAC-SHA256(secret, ts))`。
> 因此**不要**手工把密码粘到别的 MQTT 客户端里复用，时间戳过期必然失败。

**3. 后端日志显示 AMQP 已连接，但一直收不到消息**

按顺序排查：

1. 规则是否 **启用**，数据来源是否为“设备属性上报”；
2. 筛选条件 `resource = device.property` 是否命中（可先放宽条件验证）；
3. 转发目标队列名与 `IOTDA_AMQP_QUEUE` 是否一致（默认 `DefaultQueue`）；
4. 设备上报的属性编码是否与产品模型一致，尤其 `service_id` 是否为 `DefaultService`；
5. 看后端是否打印 `AMQP 收到消息（queue=...）`：
   - 有消息但 `vitals_count` 不涨 → 解析后 `device_id` 为空或字段全 0，检查规则 SQL 的 `SELECT` 是否把属性过滤掉了；
   - 完全无消息 → 问题在规则 / 队列侧，不在后端。

**4. `python-qpid-proton` 安装失败**

- Windows 优先用预编译 wheel：`pip install --only-binary=:all: python-qpid-proton`；
- 升级 pip 后重试：`python -m pip install -U pip`；
- 若公司网络拦截，配置内网镜像或离线 wheel；
- 安装失败不影响 Web 服务：`amqp_consumer` 会捕获 `ImportError`，仅打印
  `未安装 python-qpid-proton，AMQP 订阅未启动`。

**5. WebSocket 连不上（`/ws` 握手失败）**

- 端口：后端必须监听 8000，前端 `API_BASE` 为 `http://localhost:8000`；
- 协议：`file://` 页面连 `ws://` 正常；若页面是 `https://`，浏览器会要求 `wss://`，需反向代理加 TLS；
- 路径：必须是 `ws://127.0.0.1:8000/ws`（不是 `/api/ws`）；
- CORS 不作用于 WebSocket 握手，但 `CORS_ORIGINS` 配置错误会影响同页面的 HTTP 请求；
- 代理：Nginx 需显式配置 `proxy_set_header Upgrade $http_upgrade;` 与 `Connection "upgrade"`；
- 用浏览器 Network → WS 面板查看是否 101 Switching Protocols；失败时 `realtime.js`
  会在 5 次重连后回退模拟，控制台有一次性提示。

**6. SQLite 报 `database is locked`**

- 本项目每次操作都是短连接 + `timeout=10`，正常单进程不会锁死；
- 常见原因是**同时开了两个后端进程**（另开了一个 uvicorn，或上一次启动没退干净）或外部工具长事务占锁；
- 用 `Get-Process python` 检查重复进程；关闭多余的进程后再试；
- 若必须并发写入，按第十四章切换 GaussDB，而不是调大 SQLite 超时。

**7. 前端看起来“还是模拟数据”，如何判断真实链路是否生效**

按以下顺序确认：

1. 控制台是否出现 `[实时链路] 设备实时推送暂不可用，已回退本地模拟数据，页面交互不受影响。`
   ——出现即表示 WS 重连 5 次全部失败；
2. 控制台执行 `YL.realtime.state()`，`enabled` 为 `false` 或 `attempts > 0` 即未连上；
3. `curl.exe http://127.0.0.1:8000/api/iot/status`：`iot_enabled=false` 时不可能有真实帧；
4. Network → WS 面板看是否有持续 `vitals` 帧；有帧但页面不动，多半是设备编号过滤（见第十二章第 4 节）；
5. 对比 `vitals_count` 是否随模拟器间隔增长：增长说明后端在收，问题在前端展示层；
6. 若**已经回退**：模拟数据的特征是告警约每 60 秒一条且文案重复、设备详情页每 5 秒固定节奏；
   真实帧的 `event_time` 与数值都由设备侧决定。若没有出现回退提示，只是“没新帧”，
   则属于 IoT 链路无数据（见第十三章），不是模拟模式。

**8. `POST /api/device/command` 返回 503 / 502**

- **503 `CLOUD_COMMAND_DISABLED`**：`IOTDA_REGION` / `IOTDA_PROJECT_ID` / `HUAWEI_CLOUD_AK` /
  `HUAWEI_CLOUD_SK` 至少缺一项，属于“未启用”，不是故障；
- **502 `CLOUD_COMMAND_FAILED`**：已启用但上游失败，`detail` 会带华为云 HTTP 状态码或中文提示；
  常见原因：AK/SK 无 IoTDA 权限、项目 ID 与 region 不匹配、设备离线、命令未在物模型中定义；
- 服务端只记录状态码，不记录响应体与 token；排查时用控制台「设备 → 命令下发」对照验证。

**9. 时间显示不对 / 告警顺序异常**

- 所有内部时间统一为**毫秒** `BIGINT`；`amqp_consumer._to_event_ms()` 会把秒级时间戳自动 ×1000；
- IoTDA 的 `event_time` 常为 ISO8601（`2024-01-01T12:00:00Z`），代码会解析为本地时区展示；
- 若设备上报的是历史时间，冷却与排序都按该时间计算，可能出现“刚发的告警不弹”。

## 十六、安全说明（P1 IoT 链路）

- **密钥只在 `.env`**：设备密钥、AMQP AccessKey/AccessCode、华为云 AK/SK 全部通过
  `backend/.env` 或系统环境变量注入，代码中没有任何硬编码凭据；
- **`.gitignore` 已覆盖**：`.env`、`data/`、`*.db` 均被忽略（`data/iot.db` 含真实体征记录，
  属于个人健康数据，禁止提交或随包分发）；
- **日志脱敏**：模拟器横幅只打印实例地址、设备 ID、服务 ID、上报间隔与异常注入项，**不打印设备密钥**；
  AMQP 只打印 `amqps://host:port` 与队列名，SASL 用户名/密码不落日志；
  命令下发失败只记录 HTTP 状态码，不记录响应体、请求头与 `X-Auth-Token`；
- **命令下发 503 语义**：未配置 region / project_id / AK / SK 时返回
  `503 CLOUD_COMMAND_DISABLED` + `{"enabled": false}`，表示“能力未启用”，
  调用方应隐藏入口而不是重试；配置完整但上游失败才返回 `502 CLOUD_COMMAND_FAILED`；
- **传输安全**：MQTT 使用 `tls_set()`（系统 CA）并显式 `tls_insecure_set(False)`；
  AMQP 按华为云官方示例使用 `SSLDomain.ANONYMOUS_PEER`（不校验对端证书），
  身份认证依赖 SASL 接入凭证——这是平台证书链兼容性要求，部署时请限制 5671 出站范围，
  不要在不可信网络中明文传输其他业务数据；
- **最小权限**：IAM AK/SK 仅用于换 token，建议单独创建只具备 IoTDA 命令下发权限的子用户，
  不要复用管理员 AK/SK；token 只在单次请求内存中传递，不写文件、不写日志；
- **轮换建议**：演示结束后在控制台重置设备密钥与 AMQP 接入凭证，并同步更新 `.env`；
  截图、录屏、提交记录中不要出现 `.env` 内容。