# Symmd Runtime Check

This document verifies **Monaco editing**, live Markdown preview, tables, code fences, and a local image.

## Table

| Check | Expected result |
| --- | --- |
| Editor | Monaco is visible and editable |
| Preview | Changes appear without reloading |
| Image | The green Symmd card appears below |

## Fenced code

```go
package main

import "fmt"

func main() {
	fmt.Println("Symmd runtime is healthy")
}
```

## Local image

![Local Symmd runtime test card](runtime-image.svg)

## Mermaid

```mermaid
flowchart LR
    A[Start] --> B{Check}
    B -->|Yes| C[Done]
    B -->|No| D[Retry]
```

```mermaid
sequenceDiagram
    Alice->>Bob: Hello
```

```mermaid
gitgraph
    commit id: "Initial commit"
    branch develop
    checkout develop
    commit id: "<img src=x onerror=window.__mermaidInjected=true> gitgraph"
```

```mermaid
gitGraph
    commit id: "Canonical declaration"
```

```mermaid
gantt
    title Feature Roadmap 2025
    dateFormat YYYY-MM-DD

    section Core Features
    Dark Mode Support      :done, core1, 2025-01-01, 14d
    Syntax Highlighting    :done, core2, 2025-01-10, 21d

    section Advanced Features
    Mermaid Diagrams       :active, adv1, 2025-02-01, 28d
    Export to PDF          :adv2, 2025-03-01, 14d
```

```mermaid
flowchart LR
    A["<script>window.__mermaidInjected = true</script>"] --> B[Safe]
```

```mermaid
not a valid diagram
```
