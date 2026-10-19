# bin/

这里放 **Everything 命令行 `es.exe`**（本仓库不内置，`bin/es.exe` 已在 `.gitignore` 中）。

获取方式（详见 README「依赖准备」）：

1. 打开 <https://www.voidtools.com/downloads/>
2. 下载 **Everything Command-line Interface**（`ES-<版本>.x64.zip`）
3. 解压出 `es.exe` 放到本目录，即 `bin/es.exe`
4. 确保 Everything 本体在运行

也可以用环境变量 `DSH_EVERYTHING_ES` 指向别处的 `es.exe`，或把它放进
`%ProgramFiles%\Everything\es.exe`——插件的查找顺序是：

```
DSH_EVERYTHING_ES → <插件目录>\bin\es.exe → %ProgramFiles%\Everything\es.exe → PATH
```

`es.exe` 是 voidtools 的免费软件，请遵守其许可，不要把它提交进本仓库。
