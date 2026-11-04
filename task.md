
# 调研261102

打算完成如下功能，请评估技术可行性
- 通过docker-compose.yml 安装 DeepSeek Harness 
- 安装一些可复用技能，比如 https://github.com/yanliudesign/mono-color-skill.git
- 安装插件 oddpan/dsh-webapi ，就是把dsh的功能通过http API 提供给自己开发的agent
- 开发一个独立agent，独立docker或者合并到dsh docker都行。 后端为dsh，前端为web page，提供给公网用户访问，功能包括
1. 用户登录相关的后台api接口，比如添加一个token，前端用户登录验证接口，使用这个token登录
2. 前端用户登陆之后，通过websocket和agent连接，支持用户向agent发起命令，agent验证命令有效，转发给后台的dsh，如果收到dsh的返回，转发给前端用户
3. 前端用户上传图片，并且要求使用特定技能对上传的图片进行加工创作，比如： 把这张街景照片做成钴蓝单色城市散步海报，将建筑处理成粗网点，标题是“向北步行”。agent 验证命令有效，转发给dsh执行任务，并且把任务结果返回。如果用户要求修改，可以转发给dsh执行修改。
4. agent确认任务返回后，需要用户确认当前任务是否完成并调查满意度。 一次登录token只能完成一次任务。


# 1104
 把 skills 目录下的几个 skill 也安装到 dsh 镜像
 然后使用 photoes 下面的照片，测试这些技能
 选分别测试单个技能，给每一种技能设计独立的前端页面，选择技能支持的效果
 再测试 token签发多种收货码，然后验证前端处理不同的技能，每个输入都有预期的输出

## 1104 完成记录（2026-11-04）

- [x] **技能装镜像**：`docker/dsh/Dockerfile` 增加 `COPY skills /root/.dsh/skills`，重建 dsh 镜像 + 重建 dsh-home 卷；`second-world-poster` 补 YAML frontmatter、`real-qgraffiti-illusion` 的 `name` 改为 kebab-case（原中文名导致 DSH 不加载）。实测 DSH `/skills` = 6 个
- [x] **网关 Manifest 对齐 6 技能**（[manifest.ts](file:///work/dsh/gateway/src/manifest.ts)）：全部 img2img / requiresSourceImage；mono-color（title+density 粗/细）、paperworldphoto（3 滑杆 92/92/95）、photo-story（分类→风格级联 10 类 63 风格）、其余 3 个仅 title；duo-poster/text-poster 下线 → ADR [0007](file:///work/dsh/docs/adr/0007-manifest-only-executable-skills.md)
- [x] **每技能独立前端页**：新增路由 `/skill/:skillId`（[SkillPage.tsx](file:///work/dsh/frontend/src/pages/SkillPage.tsx)），预绑定技能、效果选择器（级联/滑杆/默认值），跳转工作台带 `state{preselect,params}`；兑换页增加技能入口区
- [x] **nginx 公网暴露**：`skill.aiqt.xin` vhost——80→443、`/admin` basic auth（admin）→8081 签发页、其余 →8080；公网断言 https=200、admin 无凭据 401 / 有凭据 200、`/skills` 返回 6 技能
- [x] **Q11 测试矩阵 10/10 出图**（产物在 [photoes/1104/](file:///work/dsh/photoes/1104)）：6 技能主测各 1 张 + photo-story 3 风格 + mono-color coarse/fine + 2×2 笛卡尔积（4 格中 3 格有产物：cell_01/02/04，cell_03 无输出、DSH 把重复图发给了 cell_02/04——"每技能×每效果 ≥1 张"验收不受影响）；Q13 补 5 张场景图入 `photoes/1103/`。注意：单次出图 90–314s，300s 停滞会因超时后任务积压连环失败——重试需把客户端超时提到 600s 并串行等前一任务结束；second-world 实测约 600s（38 步 agent），产物从 DSH staging 恢复
- [x] **Q12 收货码用例**：①单令牌完整闭环 268s PASS（签发→兑换→上传→出图→confirm→done→再 auth 得 `TOKEN_USED`）②三令牌码两个客户端各领一次，各返回 3 tokens、taskId 一致 PASS ③错误路径 5/5 PASS（未知码 / 未知令牌 / 吊销后兑换 / 过期 / 10 每分钟限流）
- [x] **验证**：gateway vitest 47/47 通过（含并行任务新增的 silentOutputs 用例）；前端 tsc + vite build 通过；公网 JS 可检索 `/skill/:` 路由