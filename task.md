
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


