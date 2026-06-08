Here's the **complete list of all 41 tools** and their exact call formats:

---

### 1. `bash`
```xml
<function=Qwen Core-bash>
<parameter=command>ls -la</parameter>
<parameter=cwd>/project</parameter>
<parameter=timeout>30000</parameter>
</function>
```

### 2. `read_file`
```xml
<function=Qwen Core-read_file>
<parameter=path>src/index.ts</parameter>
<parameter=encoding>utf-8</parameter>
</function>
```

### 3. `write_file`
```xml
<function=Qwen Core-write_file>
<parameter=path>src/index.ts</parameter>
<parameter=content>export const x = 1;</parameter>
</function>
```

### 4. `edit_file`
```xml
<function=Qwen Core-edit_file>
<parameter=path>src/index.ts</parameter>
<parameter=oldText>const x = 1</parameter>
<parameter=newText>const x = 2</parameter>
<parameter=replaceAll>false</parameter>
</function>
```

### 5. `glob_search`
```xml
<function=Qwen Core-glob_search>
<parameter=pattern>**/*.ts</parameter>
<parameter=cwd>/project</parameter>
<parameter=absolute>false</parameter>
</function>
```

### 6. `grep_search`
```xml
<function=Qwen Core-grep_search>
<parameter=pattern>function getUser</parameter>
<parameter=path>src/</parameter>
<parameter=caseSensitive>false</parameter>
<parameter=filePattern>*.ts</parameter>
</function>
```

### 7. `todo_write`
```xml
<function=Qwen Core-todo_write>
<parameter=todos>[{"content":"Task 1","status":"pending"},{"content":"Task 2","status":"done"}]</parameter>
</function>
```

### 8. `sequential_thinking`
```xml
<function=Qwen Core-sequential_thinking>
<parameter=thought>I need to analyze this problem...</parameter>
<parameter=nextThoughtNeeded>true</parameter>
<parameter=thoughtNumber>1</parameter>
<parameter=totalThoughts>3</parameter>
<parameter=isRevision>false</parameter>
<parameter=revisesThought>1</parameter>
<parameter=branchFromThought>1</parameter>
<parameter=branchId>alt-1</parameter>
<parameter=needsMoreThoughts>false</parameter>
</function>
```

### 9. `autonomous_agent`
```xml
<function=Qwen Core-autonomous_agent>
<parameter=task>Fix failing tests</parameter>
<parameter=workspaceRoot>/project</parameter>
<parameter=buildCommand>npm run build</parameter>
<parameter=testCommand>npm test</parameter>
<parameter=maxIterations>10</parameter>
</function>
```

### 10. `error_memory_status`
```xml
<function=Qwen Core-error_memory_status>
</function>
```

### 11. `clear_error_memory`
```xml
<function=Qwen Core-clear_error_memory>
</function>
```

### 12. `read_pdf`
```xml
<function=Qwen Core-read_pdf>
<parameter=path>/docs/report.pdf</parameter>
<parameter=pages>1-5,10</parameter>
<parameter=includeText>true</parameter>
<parameter=includeMetadata>true</parameter>
<parameter=includeImages>false</parameter>
</function>
```

### 13. `list_skills`
```xml
<function=Qwen Core-list_skills>
</function>
```

### 14. `load_skill`
```xml
<function=Qwen Core-load_skill>
<parameter=name>tdd</parameter>
</function>
```

### 15. `skill_info`
```xml
<function=Qwen Core-skill_info>
<parameter=name>tdd</parameter>
</function>
```

### 16. `skill_discover`
```xml
<function=Qwen Core-skill_discover>
<parameter=query>testing</parameter>
</function>
```

### 17. `read_text_file`
```xml
<function=Qwen Core-read_text_file>
<parameter=path>large.log</parameter>
<parameter=head>50</parameter>
<parameter=tail>20</parameter>
</function>
```

### 18. `read_multiple_files`
```xml
<function=Qwen Core-read_multiple_files>
<parameter=paths>["src/index.ts","src/utils.ts","src/types.ts"]</parameter>
</function>
```

### 19. `list_directory`
```xml
<function=Qwen Core-list_directory>
<parameter=path>src/components</parameter>
</function>
```

### 20. `create_directory`
```xml
<function=Qwen Core-create_directory>
<parameter=path>src/components/buttons</parameter>
</function>
```

### 21. `move_file`
```xml
<function=Qwen Core-move_file>
<parameter=source>src/old.ts</parameter>
<parameter=destination>src/new.ts</parameter>
</function>
```

### 22. `delete_file`
```xml
<function=Qwen Core-delete_file>
<parameter=path>temp.txt</parameter>
</function>
```

### 23. `delete_directory`
```xml
<function=Qwen Core-delete_directory>
<parameter=path>temp-folder</parameter>
<parameter=recursive>true</parameter>
</function>
```

### 24. `list_categories`
```xml
<function=Qwen Core-list_categories>
</function>
```

### 25. `load_category`
```xml
<function=Qwen Core-load_category>
<parameter=category>file</parameter>
</function>
```

### 26. `run_background`
```xml
<function=Qwen Core-run_background>
<parameter=command>npm run watch</parameter>
<parameter=name>watcher</parameter>
<parameter=cwd>/project</parameter>
</function>
```

### 27. `kill_background`
```xml
<function=Qwen Core-kill_background>
<parameter=name>watcher</parameter>
</function>
```

### 28. `list_background`
```xml
<function=Qwen Core-list_background>
</function>
```

### 29. `background_task_start`
```xml
<function=Qwen Core-background_task_start>
<parameter=toolName>Qwen Core-bash</parameter>
<parameter=toolArguments>{"command":"sleep 10"}</parameter>
<parameter=timeout>30000</parameter>
</function>
```

### 30. `background_task_status`
```xml
<function=Qwen Core-background_task_status>
<parameter=taskId>abc123</parameter>
</function>
```

### 31. `background_task_cancel`
```xml
<function=Qwen Core-background_task_cancel>
<parameter=taskId>abc123</parameter>
</function>
```

### 32. `parallel_execute`
```xml
<function=Qwen Core-parallel_execute>
<parameter=tasks>[{"toolName":"Qwen Core-bash","toolArguments":{"command":"echo hello"}},{"toolName":"Qwen Core-read_file","toolArguments":{"path":"README.md"}}]</parameter>
<parameter=timeout>30000</parameter>
</function>
```

### 33. `lsp_diagnostics`
```xml
<function=Qwen Core-lsp_diagnostics>
<parameter=path>src/</parameter>
<parameter=severity>error</parameter>
</function>
```

### 34. `lsp_goto_definition`
```xml
<function=Qwen Core-lsp_goto_definition>
<parameter=filePath>src/index.ts</parameter>
<parameter=line>10</parameter>
<parameter=character>5</parameter>
</function>
```

### 35. `lsp_find_references`
```xml
<function=Qwen Core-lsp_find_references>
<parameter=symbol>getUser</parameter>
<parameter=path>src/</parameter>
</function>
```

### 36. `spawn_subagent`
```xml
<function=Qwen Core-spawn_subagent>
<parameter=prompt>Analyze this codebase</parameter>
<parameter=systemPrompt>You are a code reviewer</parameter>
<parameter=model>qwen3.7-max</parameter>
<parameter=temperature>0.7</parameter>
<parameter=chatId>abc123</parameter>
<parameter=tools>[]</parameter>
</function>
```

### 37. `set_auth_token`
```xml
<function=Qwen Core-set_auth_token>
<parameter=token>your-auth-token-here</parameter>
</function>
```

### 38. `add_qwen_account`
```xml
<function=Qwen Core-add_qwen_account>
<parameter=label>my-account</parameter>
<parameter=token>your-auth-token-here</parameter>
</function>
```

### 39. `list_qwen_accounts`
```xml
<function=Qwen Core-list_qwen_accounts>
</function>
```

### 40. `remove_qwen_account`
```xml
<function=Qwen Core-remove_qwen_account>
<parameter=label>my-account</parameter>
</function>
```

### 41. `clear_cooldown`
```xml
<function=Qwen Core-clear_cooldown>
<parameter=label>my-account</parameter>
</function>
```

---

### Quick Reference — Parameter Types

| Type | Format |
|------|--------|
| **string** | `<parameter=key>value</parameter>` |
| **number** | `<parameter=key>30000</parameter>` |
| **boolean** | `<parameter=key>true</parameter>` |
| **array/object** | `<parameter=key>[{"a":"b"}]</parameter>` (JSON as text) |
| **optional** | Simply omit the tag |

> ⚠️ Only `todo_write` requires wrapping array values in a special `<todos>` container tag instead of `<parameter=todos>`. All other tools use `<parameter=key>value</parameter>` consistently.