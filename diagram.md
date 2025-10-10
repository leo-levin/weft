# WEFT Runtime Architecture

## System Architecture

```mermaid
graph TB
    subgraph Layer1["INPUT"]
        Source[Source Code]
        Parser[Parser]
        AST[AST]
        Source -->|string| Parser
        Parser -->|AST| AST
    end

    subgraph Layer2["RUNTIME"]
        Runtime[Runtime]
        Env[Environment]

        Runtime -->|creates| Env
    end

    subgraph Layer3["ORCHESTRATION"]
        Coord[Coordinator]
    end

    subgraph Layer4["ANALYSIS"]
        Graph[RenderGraph]
    end

    subgraph Layer5["CODE GENERATION"]
        Backends[Backends]
    end

    subgraph Layer6["EXECUTION"]
        Loop[Render Loop]
    end

    subgraph Layer7["OUTPUT"]
        Canvas[Canvas Output]
    end

    AST ==>|AST| Runtime
    Runtime ==>|ast + env| Coord
    Coord ==>|ast + env| Graph
    Graph ==>|graph metadata<br/>nodes + execOrder| Coord
    Coord ==>|ast + env| Backends
    Coord ==>|start| Loop
    Loop ==>|backend.render| Backends
    Backends ==>|output| Canvas

    Backends -.->|accesses graph via<br/>coordinator.graph| Coord

    style Layer1 fill:#e1f5ff
    style Layer2 fill:#f0e1ff
    style Layer3 fill:#d8c7ff
    style Layer4 fill:#fff4e1
    style Layer5 fill:#ffe1e1
    style Layer6 fill:#ffd4d4
    style Layer7 fill:#e8f5e8
```

## Key Data Flows

```mermaid
flowchart LR
    A[Source] -->|string| B[Parser]
    B -->|AST| C[Runtime]
    C -->|AST + Env| D[Coordinator]
    D -->|builds| E[RenderGraph]
    E -->|nodes + execOrder| D
    D -->|AST + Env| F[Backends]
    F -->|compiled code| G[Render Loop]
    G --> H[Output]

    style A fill:#e1f5ff
    style B fill:#fff4e1
    style C fill:#f0e1ff
    style D fill:#f0e1ff
    style E fill:#fff4e1
    style F fill:#ffe1e1
    style G fill:#ffd4d4
    style H fill:#e8f5e8
```

## Component Responsibilities

| Component | Responsibility | Key Methods |
|-----------|---------------|-------------|
| **Parser** | Convert source → AST | `parse(source)` |
| **Runtime** | Entry point & lifecycle | `compile()`, `start()`, `stop()` |
| **Environment** | Global state | canvas, frame, mouse, vars |
| **Coordinator** | Orchestrate compilation & rendering | `compile()`, `mainLoop()`, `getValue()` |
| **RenderGraph** | Dependency analysis | `build()`, `collectInstances()`, `topoSort()`, `tagContexts()` |
| **CPUEvaluator** | JIT fallback | `getValue()`, `compileToJS()` |
| **WebGL Backend** | GPU rendering | `compile()`, `generateFragmentShader()`, `render()` |
| **Audio Backend** | Audio playback | `compile()`, `render()` |

## Key Relationships

```mermaid
graph LR
    Coordinator -->|owns| RenderGraph
    Coordinator -->|owns| Backends
    Backends -.->|references| Coordinator
    Backends -.->|accesses| RenderGraph

    style Coordinator fill:#f0e1ff
    style RenderGraph fill:#fff4e1
    style Backends fill:#ffe1e1
```

**Ownership**: Solid arrows (→)
**References/Access**: Dashed arrows (-.->)
