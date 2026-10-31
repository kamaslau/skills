# Dictionary Attribution

`TSCharacters.txt` 与 `TSPhrases.txt` 取自 [OpenCC](https://github.com/BYVoid/OpenCC)
（Apache-2.0 许可），是本技能**默认且零依赖**的繁转简字表：脚本以「单字表 + 词组表最长匹配」
方式使用，等价于 OpenCC 的 `t2s` 配置，可完全离线运行。

若环境中装有可选的 [`opencc-js`](https://www.npmjs.com/package/opencc-js)，
`--backend auto` 会改为调用它做词组级转换（覆盖更全、速度更快），
`--backend builtin` 可强制回到本字表。
