# 老人敏感信息分级脱敏 · 独立验证报告

- **仓库**：`D:\Desktop\华为开发者项目`
- **验证时间**：2026-11-05
- **运行环境**：Windows / Node.js **v24.22.1**；无浏览器自动化环境；环境内**没有 git 可执行文件**
- **验证方式**：Node 真实执行（`new Function` + 最小 DOM / fetch / localStorage 桩），**未修改任何业务代码**；测试钩子仅通过内存字符串追加注入，不落盘。
- **git diff 来源**：用只读脚本解析 `.git`（loose objects + index v2）重建 numstat，未执行任何写操作。
- **临时脚本**：`%TEMP%\yl_verify\*.js`，验证结束后已删除。

---

## 一、总体判定

# VERDICT: PARTIAL

**理由摘要**

- 验收 1、3、4、5、6、7、8 的核心 Oracle 全部通过（共 106 条断言，0 失败）。
- 验收 2：5 个页面中列出的“展示/导出”明文路径均已脱敏或受 `canSeeRaw()` 保护；但**老人编辑抽屉对社工预填明文姓名/手机号/住址**（`elders.js:511,539,541,543`），不在允许的明文场景内，且与 README“社工均为脱敏值”矛盾。
- 验收 9：README 新增小节存在、AI 请求规则与导出规则描述准确，但“社工…均为脱敏值”与代码实际行为不一致（编辑抽屉 + 跨页面泄露）。
- **额外发现（范围外但同属该功能）**：社工角色在**老人详情页面包屑**、**实时告警浮窗**、**设备页/总览/AI 页**仍能看到老人明文姓名。这属于本次“分级脱敏”改造未覆盖的残余泄露，是判定为 PARTIAL 而非 PASS 的主要原因。

---

## 二、git diff 摘要

HEAD 为初始提交 `3311a4d`（`git log` 仅 1 条），工作区共有 **18 个文件**与 HEAD 不一致（全部未暂存、未提交）。与本次改造直接相关的 8 个文件：

| 文件 | + | - |
| --- | ---: | ---: |
| `README.md` | 21 | 1 |
| `assets/js/core/utils.js` | 47 | 3 |
| `assets/js/core/api.js` | 158 | 8 |
| `assets/js/pages/elders.js` | 87 | 12 |
| `assets/js/pages/family.js` | 9 | 2 |
| `assets/js/pages/orders.js` | 10 | 9 |
| `assets/js/pages/alerts.js` | 14 | 8 |
| `assets/js/pages/reports.js` | 34 | 0 |
| **合计** | **380** | **43** |

> 说明：仓库只有一个初始提交，无法用 git 基线精确隔离“本次脱敏改动”；diff 中可确认 `maskName / maskPhone / maskAddress / canSeeRaw`、`导出完整档案`、README 小节均为新增内容（diff 第 230、2552-2592、3972、4144 行等）。
> 一并存在的改动还有 `app.js / store.js / realtime.js / auth.js / backend/*`（18 个文件中的其余 10 个），不在本次验收文件清单内。

---

## 三、逐条验收与证据

### 1. 脱敏函数：PASS

**命令**：`node %TEMP%\yl_verify\t1_masks.js`（读取真实 `assets/js/core/utils.js`，`global.window = { YL: { store } }` 后 `new Function('window', src)(win)` 执行，源码末尾 `})(window);`）

**关键输出（24 PASS / 0 FAIL）**：

```
PASS | maskName('林水妹') => "林*妹"
PASS | maskName('林妹') => "林*"
PASS | maskName('林') => "*"
PASS | maskName(null) 未抛异常 => ""
PASS | maskName(undefined) 未抛异常 => ""
PASS | maskName('') 未抛异常 => ""
PASS | maskPhone('13912342186') => "139****2186"
PASS | maskPhone 幂等 => "139****2186"
PASS | maskPhone(null) => "—"
PASS | maskAddress('流水镇北港村 12 号') => "流水镇北港村"
PASS | canSeeRaw(social) => false
PASS | canSeeRaw(admin) => true
PASS | canSeeRaw(store 缺失) => false
PASS | canSeeRaw(role 抛异常) => false
SUMMARY pass=24 fail=0
```

- 实现位置：`utils.js:134-141`（maskPhone）、`144-154`（maskName）、`157-168`（maskAddress）、`171-179`（canSeeRaw，运行时动态读 store）。
- 对抗性边界：`null / undefined / '' / 数字型手机号 / store 缺失 / role 抛异常` 均安全。

### 2. 静态扫描：PARTIAL（展示路径合规，编辑抽屉例外）

**命令**：`node %TEMP%\yl_verify\t2_scan.js`（逐行列出 5 个文件中 `.name/.phone/.address/.familyName/elderName`）

**剩余明文命中与逐条判定**

| 文件:行 | 命中 | 判定 |
| --- | --- | --- |
| `elders.js:57,59` | `e.name / e.phone` 用于搜索过滤 | ✅ 允许（搜索过滤） |
| `elders.js:444-445` | `elderName: e.name, phone: e.phone` | ✅ 允许（内部数据组装） |
| `elders.js:480,484-485` | `plain ? 原文 : mask` | ✅ 仅“导出完整档案”路径（`raw===true`）可达 |
| `elders.js:511,539,541,543` | 编辑抽屉 `value` 预填姓名/住址/家属/电话 | ❌ **不合规**：社工拥有 `elders:edit` 权限，可看到明文；不在允许明文场景内 |
| `elders.js:632-635` | `canRaw ? 原文 : mask` | ✅ 受 `canSeeRaw()` 保护 |
| `elders.js:786` | `UI.phoneModal(elder.phone…)` | ✅ 前置 `if (!canRaw) return`（782-785） |
| `elders.js:152,522` | `v.name` 为村居名 | ✅ 非老人个人信息 |
| `family.js:36,38` | `elder.name`（头像首字 + H1） | ⚠️ README 明确声明“家属视图保留本人老人姓名”；且 `family` 权限仅家属角色拥有，store 将数据范围限定 E01，判定为**已声明的有意例外** |
| `family.js:41` | `elder.familyName` | ✅ 家属本人姓名；仅家属可见 |
| `family.js:168` | `raw ? 原文 : maskPhone` | ✅ 受 `canSeeRaw()` 保护（家属为 false） |
| `family.js:267` | `UI.phoneModal(elder.phone…)` | ✅ 前置 `if (!U.canSeeRaw())`（262-265） |
| `orders.js:300,303` | `elderName: elder.name, phone: elder.phone` | ✅ 允许（提交 payload / 内部组装） |
| `orders.js:442` | `S.roleConf().name` | ✅ 允许（角色名） |
| `orders.js:160-161,225,327,370,464,481,532` | 姓名均 `maskName` | ✅ |
| `orders.js:482` | `maskPhone(o.phone)` 恒脱敏（含管理员） | ✅ 比要求更严格 |
| `alerts.js:39` | `a.elderName` 搜索过滤 | ✅ 允许 |
| `alerts.js:204-205,280,319-321,323-324` | 姓名/住址均 mask，familyName 受 `canSeeRaw` | ✅ |
| `alerts.js:239-241,392-394` | 拨号前 `if (!U.canSeeRaw()) return` | ✅ |
| `alerts.js:415,436` | `S.roleConf().name` | ✅ 允许（角色名） |
| `reports.js:178,210,217,248` | `v.name / c.name` 为村居、慢病名 | ✅ 图表业务标签 / 聚合数据 |
| `reports.js:53` | 导出完整档案按钮 `U.canSeeRaw() ? … : ''` | ✅ |
| `reports.js` 全部 | 无任何老人姓名/电话/住址 | ✅ |

**执行级补充验证**（真实渲染，非阅读）：

- `elders.js` 列表（社工）：表格内为 `林*妹`，无 `>林水妹<`。
- `elders.js` 详情（社工）：`林*妹`，无明文姓名/手机号/门牌地址。
- `elders.js` 详情（管理员）：明文姓名/手机号/住址均出现（正向对照，与 README 一致）。
- `elders.js` 列表（管理员）：仍为 `林*妹`（README：列表页脱敏）。
- `family.js`：家属 Hero 保留姓名；设备页手机号 `186****5147`、无明文、无拨打按钮、地址仅村居级；管理员设备页显示原文并渲染拨打按钮。

**结论**：5 个页面的展示/导出路径已按要求脱敏；**唯一不合规的在范围内的明文点是编辑抽屉预填**。

### 3. CSV 导出：PASS

**命令**：`node %TEMP%\yl_verify\t3_elders.js` / `t4_orders_alerts_api.js`（在内存中给 `exportElders` 挂测试钩子并捕获 `U.download`）

**elders.js 默认导出**：

```
默认导出 CSV 第二行:
E01,林*妹,女,84,350128********1135,流水村,流水镇,半自理,安康版,YL-PT-2024-1001,84,98,林*雅,186****5147
PASS | 默认导出姓名为掩码 林*妹
PASS | 默认导出不含明文姓名 林水妹
PASS | 默认导出手机号为掩码 186****5147
PASS | 默认导出不含明文手机号
```

**elders.js raw 导出**：

```
明文导出 CSV 第二行:
E01,林水妹,女,84,350128********1135,流水村,流水镇,半自理,安康版,YL-PT-2024-1001,84,98,林小雅,18651475147
PASS | raw=true 输出明文姓名
PASS | raw=true 输出明文手机号
```

- `exportElders(list, raw)` 的 `raw` 仅在 `elders.js:417-424` 的 `#exportArchive` 二次确认回调中传 `true`；`reports.js:265-288` 的“导出完整档案”同样二次确认后才调用 `YL.pages.elders.exportArchive()`。
- 身份证始终 `maskIdCard`（`elders.js:480`），即使 raw 模式也不输出明文。

**orders.js / alerts.js**：

```
工单CSV(社工):   WO2026110401,陈*金,北港村,…
工单CSV(管理员): WO2026110401,陈木金,北港村,…
告警CSV(社工):   AL2026110501,…,林*妹,84,…
告警CSV(管理员): AL2026110501,…,林水妹,84,…
PASS | 工单导出(社工)姓名脱敏 / 工单导出(管理员)姓名原文
PASS | 告警导出(社工)姓名脱敏 / 告警导出(管理员)姓名原文
```

代码位置：`orders.js:225`、`alerts.js:280`，均为 `raw ? 原文 : U.maskName(...)`，与验收标准一致。
> 观察：订单/告警导出在管理员下直接输出原文，没有“二次确认”；这是验收标准 3 预期的行为，但与 README“CSV 导出默认输出脱敏值”的措辞存在歧义（见第 9 条）。

### 4. “导出完整档案”仅管理员 + 取消不导出：PASS

**真实渲染断言**：

```
按钮渲染：social=false family=false admin=true
PASS | 社工不渲染「导出完整档案」按钮
PASS | 家属不渲染「导出完整档案」按钮
PASS | 管理员渲染「导出完整档案」按钮
PASS | 打开二次确认模态框 | 导出完整档案
PASS | 取消前未导出
PASS | 模态框提供取消按钮 data-close
PASS | 确认按钮已挂载监听
PASS | 点击确认后关闭模态框
PASS | 点击确认后触发导出回调
```

报表页同样验证：

```
PASS | 报表页社工不渲染「导出完整档案」
PASS | 报表页管理员渲染「导出完整档案」
PASS | 确认前未调用明文导出
PASS | 确认后调用 elders.exportArchive（明文）
PASS | 报表 CSV 不含老人姓名 / 手机号
```

- `elders.js:137` 与 `reports.js:53` 均为 `U.canSeeRaw() ? … : ''`；
- 取消按钮为 `data-close`，只有 `[data-confirm-export]` / `[data-confirm]` 的 click 才调用 `onOk()`（`elders.js:458-473`、`reports.js:265-288`），未确认前 `downloads.length === 0`。

### 5. api.js `pickElder()`：PASS

**命令**：`node %TEMP%\yl_verify\t4_orders_alerts_api.js`（真实调用 `YL.api.chatStream`，用假 `fetch` 截获实际请求体）

**实际发送给 `/api/chat` 的 elder 对象**：

```json
{"name":"该老人","gender":"女","age":84,"village":"流水村","town":"流水镇","health":"semi",
 "chronic":["高血压","2 型糖尿病"],
 "lastVitals":{"hr":84,"sbp":134,"dbp":81,"spo2":98,"temp":36.7,"at":1793862761482}}
```

```
PASS | payload.elder.name 恒为「该老人」
PASS | payload.elder 不携带 phone / idCard / address 字段
PASS | payload.elder 不含真实姓名 / 手机号
PASS | payload.elder 保留 village / town
PASS | payload 整体不含身份证片段
```

- 返回字面量位置：`api.js:203-229`，`name: '该老人'`（213），仅 `village/town` 为地域字段。
- 验证的是**实际 fetch body**，不是只读代码。

### 6. 无会话时 `store.role()` 默认 `'admin'` 的风险：PASS（当前无泄露，但有设计脆弱性）

**命令**：`node %TEMP%\yl_verify\t6_nosession.js`（真实执行 `store.js` + `app.js boot()`）

```
PASS | 无会话时 S.session() 为 null
PASS | 无会话时 S.role() 返回默认 'admin' | admin
PASS | 因此 U.canSeeRaw() 在无会话时为 true
PASS | 无会话启动后仍停留在登录页（appView.hidden=true）
PASS | 无会话启动后 authView 可见
PASS | 无会话启动后路由未启动 | false
PASS | 无会话启动后 #view 未写入任何页面 HTML
PASS | 无会话启动后未渲染任何老人明文
PASS | 路由未启动 => 修改 hash 不会触发页面渲染
PASS | 修改 hash 后 #view 仍为空
```

**结论**：
- `store.js:193` 确实在无会话时返回 `'admin'`，`canSeeRaw()` 随之返回 `true`（已实测）。
- 但真实路径中 `app.js:713-717` 在 `S.session()` 为空时直接 `showAuth()` 并 `return`，**不会**调用 `launchApp()`，路由 `start()` 未执行，`#view` 不渲染；即使手动改 hash 也不会触发 `onRoute`。
- 因此**当前版本不会因该默认值造成明文泄露**；但这是纵深防御缺口：任何未来在登录前渲染 elders 组件的代码都会默认获得 admin 明文权限。建议 `role()` 无会话时返回 `null/guest`。

### 7. ES5 合规：PASS

**命令**：`node %TEMP%\yl_verify\t5_es5.js`（去除注释、字符串、模板字符串与正则字面量后扫描）

```
PASS | assets/js/core/utils.js 无 let/const/箭头函数/模板字符串/展开运算符
PASS | assets/js/core/api.js …
PASS | assets/js/pages/elders.js …
PASS | assets/js/pages/family.js …
PASS | assets/js/pages/orders.js …
PASS | assets/js/pages/alerts.js …
PASS | assets/js/pages/reports.js …
SUMMARY pass=7 fail=0
```

> 原始正则扫描曾命中 `utils.js:294` 的反引号（正则字面量 `/`/g`，ES5 合法）与 `api.js:233` 注释中的 `'...'`，去除字符串/正则后均无命中。

### 8. `node --check`：PASS

**命令**：对全部 11 个改动 JS 逐一 `node --check`

```
OK   node --check assets/js/core/utils.js
OK   node --check assets/js/core/api.js
OK   node --check assets/js/core/store.js
OK   node --check assets/js/core/realtime.js
OK   node --check assets/js/app.js
OK   node --check assets/js/pages/elders.js
OK   node --check assets/js/pages/family.js
OK   node --check assets/js/pages/orders.js
OK   node --check assets/js/pages/alerts.js
OK   node --check assets/js/pages/reports.js
OK   node --check assets/js/pages/auth.js
exit_fail=0
```

### 9. README 一致性：PARTIAL

`README.md:33-51` 新增“数据脱敏与权限”小节，包含三角色表格、导出规则、AI 请求规则：

| README 声明 | 代码实际 | 结论 |
| --- | --- | --- |
| admin 列表脱敏 / 详情原文 | `elders.js:240` 列表 mask；`632-635` 详情 raw | ✅ 实测一致 |
| 社工姓名脱敏（林水妹→林*妹）、手机号脱敏、住址到村居 | 列表/详情/CSV 均一致 | ✅（但见下方例外） |
| 社工“均为脱敏值” | 编辑抽屉 `elders.js:511/539/541/543` 预填明文 | ❌ 不一致 |
| 家属保留本人老人姓名 / 手机号一律脱敏 / 住址村居级 | `family.js:36-41` 保留姓名；`168` 脱敏；无门牌 | ✅ 一致 |
| 导出：档案/告警/工单默认脱敏 | `exportElders` / `orders:225` / `alerts:280` 非 admin 均 mask | ✅ 一致 |
| “导出完整档案”仅管理员 + 二次确认 | `elders.js:137/458-473`、`reports.js:53/265-288` | ✅ 实测一致 |
| AI 请求姓名固定“该老人”，不带手机号/身份证/住址，保留村居乡镇 | 实测 fetch body 完全一致 | ✅ 一致 |

**额外不一致**：README 的“社工…脱敏”在以下跨页面路径被打破（见第四节 F1-F4），README 未提示这些例外。

---

## 四、发现的问题（按严重度）

| 编号 | 严重度 | 位置 | 问题 | 证据 |
| --- | --- | --- | --- | --- |
| **F1** | 高 | `app.js:308-310` | 社工打开 `/elders/E01` 详情页时，面包屑直接输出 `D.ELDER_MAP[id].name` 明文 | 执行 `renderCrumb`（社工）输出：`<span class="crumb current">林水妹</span>` |
| **F2** | 高 | `app.js:501-502` | 实时告警浮窗对社工输出 `alert.elderName` / `alert.familyName` 明文 | 执行 `showAlertPop`（社工）输出文本：`林 林水妹 84 岁 · 紧急联系人 林小雅` |
| **F3** | 中 | `devices.js:144,177,368`；`overview.js:43`；`ai.js:105,113,178,205,291` | 设备页、总览实时告警、AI 页均直接渲染 `elderName / elder.name`，社工可访问这些页面 | 全量静态扫描输出（t2 扩展扫描） |
| **F4** | 中 | `elders.js:511,539,541,543` | 编辑抽屉对社工预填明文姓名、住址、家属姓名、手机号 | 真实执行 `openElderForm('E01')`（社工）：`明文姓名=true 明文手机号=true 明文地址=true` |
| **F5** | 低 | `ui.js:262-265` | `UI.person()` 直接 `esc(elder.name)`；当前无调用点，属潜在复用风险 | 全仓 `UI.person(` 调用点扫描为空 |
| **F6** | 低 | `README.md:39-47` | “社工均为脱敏值”“CSV 默认输出脱敏值”与管理员/编辑抽屉实际行为存在措辞偏差 | 见第 9 条表格 |

> F1/F2 已用真实代码执行复现；F3/F5 为静态扫描；F4 为真实渲染复现。

---

## 五、最终判定依据

| 验收项 | 结果 |
| --- | --- |
| 1 脱敏函数 | ✅ PASS |
| 2 静态扫描（5 文件） | ⚠️ PARTIAL（展示路径合规；编辑抽屉不合规；family 为已声明例外） |
| 3 CSV 导出 | ✅ PASS |
| 4 完整档案仅 admin + 取消不导出 | ✅ PASS |
| 5 `pickElder()` | ✅ PASS |
| 6 无会话默认 admin 风险 | ✅ PASS（当前无泄露；设计脆弱） |
| 7 ES5 语法 | ✅ PASS |
| 8 `node --check` | ✅ PASS |
| 9 README 一致性 | ⚠️ PARTIAL |

**结论：`VERDICT: PARTIAL`**

- 核心脱敏能力（函数、列表/详情/CSV、导出授权、AI 请求裁剪）实现正确且经真实执行验证；
- 但“分级脱敏”没有覆盖完整用户旅程：社工仍可在详情页面包屑、实时告警浮窗、设备页、总览、AI 页看到老人明文姓名，编辑抽屉还会预填明文手机号/住址；
- 这些是可修复的真实缺陷，不是文档性吹毛求疵；在修复前不应判定为 PASS。

---

*本报告仅为验证结论，未修改业务代码、未提交任何 git 变更。*