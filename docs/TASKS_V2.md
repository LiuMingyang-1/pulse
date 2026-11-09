# Tasks 完成态 / 计划日期：切换与回滚

这份说明只描述怎么安全切换。本仓库的改动**默认不切换**：不设置 `TASKS_SCHEMA` 时，读、写、今日安排、ICS 都与现在的 Status 行为一致。不要在合并或部署本 PR 时顺便改飞书字段、改记录、清队列或跑生产同步。

## 两个开关，缺一不可

完成态不能看 checkbox 是不是 truthy。飞书里「没这列」和「这列未勾选」都会呈现成空 / `false`。

| 信号 | 从哪来 | 含义 |
| --- | --- | --- |
| `gate` | 环境变量 `TASKS_SCHEMA` | 人决定的开关。未设置、空、`legacy`、以及任何无法识别的值都是 `legacy`。 |
| `capability` | 每次需要时调用多维表格**字段列表**，按**字段名**匹配 | `v2` = 配置的两列都在。`legacy` = 探过了但缺列。`unknown` = 没探或探测失败。 |

读权威（任务是否完成）只在 `gate=v2` **且** `capability=v2` 时改为复选框：

- `true` → 已完成
- `false`、以及该列已确认存在时的空单元格 → 未完成

此时**不用** `Status == Done OR 复选框`。否则取消勾选后，旧的 Done 会把完成态弹回去。

`gate=compat`：仍然按 Status 读（今日安排也不变），但新的勾选/取消会**双写**复选框和 Status。

`gate=legacy`（默认）：不探测字段（除非队列里已经有带 `completed` 的旧载荷），不请求新列，不根据复选框改变任何卡片。

字段名可配，禁止写死 field id：

```
FEISHU_FIELD_COMPLETED=已完成
FEISHU_FIELD_PLAN_DATE=计划日期
```

名字撞上 `Task` / `Due` / `Status` / `Type` / `Priority` / `Scheduled Start` / `Scheduled End` 时，该名字作废，能力保持 legacy。

同步把判定写进 `todo.data.tasks_schema`（旧客户端会忽略）。`write_audit` 保留最近 20 条勾选/取消，同步不会清掉它。

## 语义（切换之后）

- **已完成**：唯一完成态。勾选与取消都写回复选框，并双写 Status（完成 → `Done`，取消 → 该条真正的 `prev_status`，没有则 `Inbox`）。不会把缺状态发明成 `Doing`。
- **计划日期**：只表示「选中某一天、但还没有时间块」。空就是空。不会从 Doing、Scheduled Start/End 或 Due 回填。历史值保持原样。
- **Scheduled Start / End**：时间块。完成不清除这两列。`End <= Start`、只有 Start、只有 End 都不自动修。
- **Doing**：不是「正在进行」。没有合法时间块、计划日期也不是今天的 Doing，不会出现在今日安排里。
- **Due**：仍是独立截止日期。Reminder 的「已过期 + 今天起 3 个自然日」不变。Campus 没有单独分支，Due 窗口也不改。
- **ICS**：仍是「两列都有值，且 Start 落在过去 3 天到未来 14 天」。任何 Status 都收录，Done 的历史时间块还在。UID 仍是 `record_id@pulse`。不写 Apple 日历，不写飞书日历。计划日期不会变成日程。

## 今日安排怎么排

默认（legacy）不变：`Status=Doing` 且两列时间都在，并且 **Start 落在今天**。

`TASKS_SCHEMA=v2` 且两列都探测到之后，今日安排是**并集**，不是「计划日期是今天 AND 时间齐全」：

1. **已排期**：Start、End 都非空，`End > Start`，并且区间盖到今天（上海自然日）：`Start < 次日 0 点 && End > 当日 0 点`。跨午夜因此算今天。不看 Doing，不看计划日期。已完成的不放进这张卡片，但 ICS 仍保留时间块。
2. **今日选中 · 未排期**：计划日期的上海日历日是今天，没有合法时间块，且未完成。类型为 Reminder 的仍只走 Reminder 卡。

合法时间块若落在别的日子，算已排期，不塞进「未排期」。Doing 且没有时间、计划日期也为空：哪一边都不进。

卡片上：只有时间块时版式与现在相同；两边都有时分「已排期」和「今日选中 · 未排期」；只有未排期时只显示第二段。旧前端忽略 `planned`，仍能画 `events`。

## 队列

`pending_writes` 永远带 `status`，这样旧版本 Worker 仍能把 Status 写回去，不能靠清空队列来升级。

- 旧载荷 `{ record_id, status }` 在 compat/v2 且字段已确认存在时，就地补上 `completed: status === 'Done'`，并清掉过期的 `landed`，迫使下一次读同时核对两列。Doing / Inbox 补成 `completed: false`，不是「进行中」。
- 补的是**这一条已经排队的意图**，不是扫表回填。
- 同一条重复勾选/取消只保留最后一条。
- 飞书 `batch_update` 失败：整条留在队列，`landed` 不置位，下一轮重试。不丢。
- 宽读还没追上：`landed` 后继续挂着，不重发，避免覆盖别人的修改。v2 要 Status **和**复选框都对上才算追上。只对上 Done、复选框仍是 true，取消完成不会被提前 ack。
- 探测失败（`capability=unknown`）且载荷已有 `completed`：本轮不发送，队列原样留下，避免只写 Status 就把复选框半截丢掉。
- 探测确认列已删除：放弃复选框半截，仍按 Status 排空，避免坏列把队列卡死。
- 勾选和同步抢同一行：仍用 `updated_at` 乐观锁。同步写不上就跳过这一轮，队列留在后写的那一版里。

D1 没有新表、没有新列。回滚不需要 down migration。不要用不可逆 DDL。

## 生产切换前置条件

全部满足再改环境变量。任何一条不满足就保持未设置。

1. 本 PR 已由人合并并部署。部署本身不切换（`wrangler.toml` 不写 `TASKS_SCHEMA`）。
2. 原表备份已核对：记录数、`record_id`、Status 分布、Scheduled、Due 都还在。备份不是按原 `record_id` 的恢复手段。
3. 生产表已有两列，名字与 `FEISHU_FIELD_COMPLETED` / `FEISHU_FIELD_PLAN_DATE` 一致（默认 `已完成`、`计划日期`）。类型：复选框、日期时间。不要把沙盒 field id 抄进配置。
4. 复选框已按**当时的** Status 回填：Done → true，其余 → false。回填之后到切换之前，不要再有未双写的完成态改动；或者先走下面的 compat，把这段窗口的勾选双写掉。
5. 计划日期保持空。不要用 Doing 或 Scheduled 推断后填上。
6. 下列坏数据保持原样，不要自动修：Doing 但没有 Scheduled；历史 Done 只有 Start；`End < Start`。
7. `pending_writes` 为空，或你接受 compat 会把旧的 `{status}` 升级成带 `completed` 的双写。
8. Reminder / Due / ICS 订阅 URL 不在这次切换里改。

## 切换

用 `wrangler secret` 不适合这个开关（它不是密钥）。在 Worker 变量里改，然后等一轮同步（刷新按钮或 cron），再看 `todo.data.tasks_schema`。

`wrangler.toml` 里 `keep_vars = true`，而且 **不要** 把 `TASKS_SCHEMA` 写进 `[vars]`。下次正常的 `wrangler deploy`（含 GitHub Actions 那条不带额外参数的 deploy）会保留远程的明文 `TASKS_SCHEMA`，无论当时是 `compat` 还是 `v2`。`[vars]` 里的 `FEISHU_BASE_TOKEN` 和 `FEISHU_TABLE_ID` 仍会按文件里的值上传，同名远程值被覆盖。secret 本来就不会被 deploy 删掉。回滚仍是改或删除远程变量，不是改这一行。

1. 部署后先什么都不设。打开看板，待办、今日安排、日历订阅应与切换前一致。日志里不应出现 `[feishu] tasks-schema`。
2. 可选 compat：`TASKS_SCHEMA=compat`。再同步一次。`tasks_schema` 应为 `gate=compat`、`capability=v2`、`read=legacy`。勾一条再取消：飞书里复选框和 Status 一起变，看板仍按 Status 显示。`write_audit` 有记录。
3. 确认队列空（或只剩你刚做的、已经落地的写入）。
4. `TASKS_SCHEMA=v2`。再同步。`read` 应为 `v2`。
5. 抽查：
   - 一条 Status 仍是 Done、但复选框为 false 的记录显示为未完成，刷新后不会弹回完成。
   - 计划日期为空、但今天有合法时间块的旧记录出现在时间轴上。
   - 计划日期是今天、没有时间块的记录出现在「今日选中 · 未排期」，不要求 Scheduled 齐全。
   - 跨午夜（昨天开始今天结束，或今天开始明天结束）的合法区间在时间轴上；`End < Start` 不在。
   - 今天完成的仍在待办底部；更早的完成不因为这次切换涌进今天。
   - 日历订阅里同一条的 UID 仍是 `<record_id>@pulse`，Done 的时间块还在，窗口仍是 Start 的前 3 后 14 天。

## 回滚

优先回到 **compat**，而不是直接删列或清队列。

1. `TASKS_SCHEMA=compat`：看板改回按 Status 读，新的勾选仍双写复选框。已经双写过的完成态还在 Status 里，所以不会丢。
2. 若要完全回到旧行为：去掉 `TASKS_SCHEMA`。新的勾选只写 Status。队列里**已经带** `completed` 的条目，Worker 仍会在字段还在时把复选框写完再放行；探测失败则整条留在队列里，下一轮再试。
3. 不要删除两列，不要 `DELETE` / 清空 `pending_writes`，不要改 D1 结构。旧代码只认 `status`，新载荷里的 `status` 仍在，所以降级部署也能排空 Status。复选框那一半要等这版代码再部署才会补完。
4. 客户端缓存了带 `planned` 的日程也没关系：把开关拨回 legacy 再同步，下一份 `schedule` 就没有 `planned`。旧页面本来就忽略它。

## 检查项

- [ ] `tasks_schema.read` 与你以为的开关一致（legacy 时这个对象可以不存在）
- [ ] `tasks_schema.capability` 在字段没建好时不是 `v2`
- [ ] 取消完成后刷新，完成态不因旧 Done 弹回
- [ ] 队列里失败项还在，且带原来的 `requested_at`
- [ ] 计划日期没有被同步写成非空（除非人在飞书里填过）
- [ ] ICS 事件数量没有因为「只剩未完成」而变少
- [ ] Reminder 仍含过期和今天起 3 个自然日内的项

## 限制

- 本 PR 不创建字段、不回填、不改生产记录、不部署。
- 计划日期不会自动出现。旧的「今天想做但没排钟点」在你手工填上计划日期之前，不会进「未排期」。
- Doing 没有时间块的那一条，切换后不在今日安排里，它只留在待办列表。
- 只有 Start、或 End 早于 Start 的历史行不会被改，也不会被当成今天的时间块。
- 合法时间块在别的日子、计划日期却是今天：时间轴不显示（区间不覆盖今天），「未排期」也不显示（它已经有合法区间）。它仍在待办列表里。这是数据不一致，不自动修。
- Reminder 的完成仍看 Status，不看复选框。待办卡只收 `Type=Task`。
- 备用脚本 `scripts/sync-feishu.mjs` 没有字段列表探测。`TASKS_SCHEMA` 未设置时它不请求新列；队列里已有 `completed` 的条目会先写 Status，并**留在队列**里，等 compat/v2 再写复选框。切换期间请用 Worker cron，不要和脚本同时跑。
- 索引滞后仍可能有几分钟。滞后窗口里以本地 `pending` 为准，不要手工清队列。
