# Qwen Gate Architecture

Technical architecture and design documentation for Qwen Gate.

## Table of Contents

- [Overview](#overview)
- [System Architecture](#system-architecture)
- [Component Architecture](#component-architecture)
- [Data Flow](#data-flow)
- [Key Subsystems](#key-subsystems)
  - [Session Pool](#session-pool)
  - [Echo Detection](#echo-detection)
  - [Streaming Pipeline](#streaming-pipeline)
- [Technology Stack](#technology-stack)
- [Design Decisions](#design-decisions)
- [Scalability](#scalability)
- [Security Architecture](#security-architecture)

## Overview

Qwen Gate is an OpenAI-compatible API proxy that provides access to Qwen AI models through intelligent browser automation. It bridges the gap between Qwen's web interface and standard AI API clients by:

1. **Automating browser interactions** with Qwen's chat interface
2. **Managing multiple accounts** with automatic rotation and session pooling
3. **Providing OpenAI-compatible endpoints** for seamless integration
4. **Optimizing responses** with echo detection and content filtering
5. **Monitoring and debugging** through a real-time dashboard

### Core Principles

- **Transparency**: OpenAI-compatible API that works with existing clients
- **Reliability**: Multi-account rotation and automatic failover
- **Efficiency**: Content filtering and intelligent caching
- **Observability**: Real-time monitoring and comprehensive logging
- **Safety**: Echo detection and content filtering

## System Architecture

### High-Level Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        API Clients                          │
│  (OpenAI SDK, curl, custom apps, LangChain, etc.)           │
└────────────────┬────────────────────────────────────────────┘
                 │
                 │ OpenAI-compatible API
                 │ POST /v1/chat/completions
                 │ GET /v1/models
                 │
┌────────────────▼───────────────────────────────────────────┐
│                     Qwen Gate Server                       │
│  ┌──────────────────────────────────────────────────────┐  │
│  │              API Layer (Hono)                        │  │
│  │  - Request validation                                │  │
│  │  - Authentication                                    │  │
│  │  - Rate limiting                                     │  │
│  └────────────────┬─────────────────────────────────────┘  │
│                   │                                        │
│  ┌────────────────▼─────────────────────────────────────┐  │
│  │           Session Pool Manager                       │  │
│  │  - Account rotation                                  │  │
│  │  - Session lifecycle                                 │  │
│  │  - Health monitoring                                 │  │
│  └────────────────┬─────────────────────────────────────┘  │
│                   │                                        │
│  ┌────────────────▼─────────────────────────────────────┐  │
│  │        Browser Automation Layer (Playwright)         │  │
│  │  - Browser instance management                       │  │
│  │  - Qwen chat interface interaction                   │  │
│  │  - Response extraction                               │  │
│  └────────────────┬─────────────────────────────────────┘  │
│                   │                                        │
│  ┌────────────────▼─────────────────────────────────────┐  │
│  │           Response Pipeline                          │  │
│  │  - Echo detection & filtering                        │  │
│  │  - Content filtering                                  │  │
│  │  - OpenAI format conversion                          │  │
│  └────────────────┬─────────────────────────────────────┘  │
│                   │                                        │
└───────────────────┼────────────────────────────────────────┘
                    │
                    │ Streaming/Non-streaming response
                    │
┌───────────────────▼─────────────────────────────────────────┐
│                      API Clients                            │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│                Dashboard (Vanilla HTML/JS)                   │
│  - Real-time monitoring                                     │
│  - Account management                                       │
│  - Configuration UI                                         │
│  - Request logs                                             │
└─────────────────────────────────────────────────────────────┘
```

## Component Architecture

### 1. API Layer (Hono)

**Location**: `src/routes/`

The API layer handles all HTTP requests and provides OpenAI-compatible endpoints.

**Components**:

- `chat.ts` - Chat completion endpoint handler
- `chatStreaming.ts` - Streaming response logic
- `chatHelpers.ts` - Request/response utilities
- `accounts.ts` - Account management endpoints

**Responsibilities**:

- Request validation and parsing
- Authentication (API key verification)
- Rate limiting
- Response formatting (OpenAI format)
- Error handling

### 2. Session Pool Manager

**Location**: `src/services/sessionPool.ts`

Manages browser sessions and Qwen account rotation.

**Responsibilities**:

- Session lifecycle management (create, reuse, destroy)
- Account rotation and load balancing
- Session health monitoring
- Rate limit tracking and cooldown
- Session pooling for performance

**Key Classes**:

- `SessionPool` - Main pool manager
- `Session` - Individual browser session
- `AccountManager` - Account state tracking

### 3. Browser Automation Layer

**Location**: `src/services/browser.ts`

Handles Playwright browser automation for Qwen interaction.

**Responsibilities**:

- Browser instance management
- Qwen chat interface navigation
- Message sending and response extraction
- Session authentication
- Error recovery

**Key Functions**:

- `launchBrowser()` - Start browser instance
- `createSession()` - Initialize Qwen session
- `sendMessage()` - Send chat message
- `extractResponse()` - Parse Qwen response

### 4. Response Pipeline

**Location**: `src/routes/pipeline/`

Processes and optimizes Qwen responses before returning to client.

**Components**:

- `StreamingEchoFilter.ts` - Echo detection and filtering
- `StreamingContentFilter.ts` - Content sanitization

**Pipeline Stages**:

1. **Raw Response** - Extract from Qwen
2. **Echo Detection** - Filter verbatim tool echoes
3. **Content Filtering** - Remove sensitive data
4. **Format Conversion** - Convert to OpenAI format
5. **Streaming** - Send to client

### 5. Configuration Service

**Location**: `src/services/configService.ts`

Centralized configuration management with three-tier priority.

**Priority Order**:

1. Environment variables (highest)
2. config.json (persistent)
3. Default values (fallback)

**Features**:

- Runtime configuration updates
- Web UI integration
- Type-safe configuration access
- Hot reload support

### 6. Dashboard (Frontend)

**Location**: `src/routes/dashboard/`

Five standalone HTML pages served by Hono at `/dashboard/*` routes. No framework, no build step.

**Pages**:

- `overview.ts` - System health KPIs and session pool status
- `logs.ts` - Real-time request log with foldable detail sections
- `accounts.ts` - Account management with cooldown indicators
- `network.ts` - Network request viewer and chunk inspection
- `settings.ts` - Configuration editor for runtime settings

**Features**:

- Real-time SSE updates for live data
- Inline CSS with claymorphism design (warm cream palette)
- Sidebar navigation shared across all pages
- Template literals with embedded JS for interactivity

## Data Flow

### Chat Completion Flow

```
1. Client Request
   POST /v1/chat/completions
   {
     "model": "qwen-max",
     "messages": [...],
     "stream": true
   }
   │
   ▼
2. API Layer
   - Validate request
   - Check API key
   - Parse messages
   │
   ▼
3. Session Pool
   - Select available account
   - Get/create browser session
   - Check rate limits
   │
   ▼
4. Browser Automation
   - Navigate to Qwen chat
   - Send user message
   - Wait for response
   │
   ▼
5. Response Extraction
   - Parse Qwen response
   - Extract text content
   - Detect tool calls
   │
   ▼
6. Response Pipeline
   - Echo detection (bidirectional containment)
   - Content filtering
   - Format to OpenAI schema
   │
   ▼
7. Streaming Response
   - Send SSE chunks
   - Handle tool calls
   - Complete with [DONE]
   │
   ▼
8. Client Receives
   data: {"choices": [{"delta": {"content": "..."}}]}
   data: [DONE]
```

### Tool Calling Flow

```
1. Client Request with Tools
   {
     "messages": [...],
     "tools": [{"type": "function", ...}]
   }
   │
   ▼
2. Qwen Processes Request
   - Analyzes available tools
   - Decides to call tool
   - Returns tool_call
   │
   ▼
3. Response Pipeline
   - Detects tool_call in response
   - Formats as OpenAI tool_call
   - Returns to client
   │
   ▼
4. Client Executes Tool
   - Runs function locally
   - Gets result
   │
   ▼
5. Client Sends Tool Result
   {
     "messages": [
       {...user message...},
       {...assistant tool_call...},
       {"role": "tool", "content": "result"}
     ]
   }
   │
   ▼
6. Qwen Continues
   - Processes tool result
   - Generates final response
   │
   ▼
7. Echo Detection
   - Checks if response echoes tool result
   - Filters verbatim echoes
   - Returns clean response
```

## Key Subsystems

### Session Pool

**Purpose**: Efficiently manage multiple browser sessions across Qwen accounts.

**Architecture**:

```
SessionPool
├── AccountManager
│   ├── Account 1 (active, 5 sessions)
│   ├── Account 2 (active, 3 sessions)
│   └── Account 3 (cooldown, 0 sessions)
├── SessionCache
│   ├── Session A (idle, ready)
│   ├── Session B (active, in-use)
│   └── Session C (idle, ready)
└── HealthMonitor
    ├── Rate limit tracking
    ├── Error rate monitoring
    └── Session validation
```

**Session Lifecycle**:

1. **Create**: Launch browser, authenticate with Qwen
2. **Use**: Send messages, extract responses
3. **Idle**: Keep alive for reuse
4. **Recycle**: Refresh authentication
5. **Destroy**: Close browser, cleanup resources

**Load Balancing**:

- Round-robin across active accounts
- Weighted by account health
- Automatic failover on errors
- Rate limit awareness

### Echo Detection

**Purpose**: Prevent AI from echoing tool results verbatim.

**Algorithm**: Bidirectional Containment with Shingle Analysis

```
1. Extract Tool Results
   - Parse tool_call responses
   - Store result text
   - Create shingle fingerprints

2. Monitor Streaming Response
   - Process response line-by-line
   - Compute shingles for each line

3. Check for Echo
   For each response line:
   a. Compute shingles (5-grams)
   b. Check containment:
      - output_shingles ⊆ tool_result_shingles
      - tool_result_shingles ⊆ output_shingles
   c. Calculate Jaccard similarity
   d. If similarity > threshold (0.9):
      - Flag as echo
      - Filter from response

4. Bidirectional Check
   - Prevents false positives
   - Requires both directions to match
   - More accurate than one-way check
```

**Configuration**:

```bash
ECHO_DETECTOR=true
ECHO_JACCARD_THRESHOLD=0.9
ECHO_MIN_LINE_LENGTH=20
ECHO_MIN_UNIQUE_SHINGLES=8
```

**Example**:

```
Tool Result: "The file contains 100 lines of code."
Response: "The file contains 100 lines of code." ← ECHO (filtered)
Response: "Based on the analysis, the file has 100 lines." ← OK (rephrased)
```

### Streaming Pipeline

**Purpose**: Process and stream responses in real-time with minimal latency.

**Architecture**:

```
Qwen Response Stream
         │
         ▼
┌─────────────────┐
│ Chunk Buffer    │ Accumulate partial chunks
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Echo Filter     │ Check for verbatim echoes
└────────┬────────┘
         │
         ▼
┌─────────────────┐
 │ Content Filter  │ Remove sensitive data
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Format Converter│ Convert to OpenAI format
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ SSE Encoder     │ Encode as Server-Sent Events
└────────┬────────┘
         │
         ▼
  Client Stream
```

**Optimizations**:

- **Chunk Buffering**: Accumulate small chunks for efficiency
- **Parallel Processing**: Filter and transform in parallel
- **Backpressure Handling**: Respect client consumption rate
- **Memory Management**: Stream processing, no full buffering

## Technology Stack

### Backend

| Technology     | Purpose              | Version |
| -------------- | -------------------- | ------- |
| **Node.js**    | Runtime              | 18+     |
| **TypeScript** | Type safety          | 5.7+    |
| **Hono**       | Web framework        | Latest  |
| **Playwright** | Browser automation   | Latest  |
| **tsx**        | TypeScript execution | Latest  |

### Frontend

| Technology       | Purpose                   | Notes                 |
| ---------------- | ------------------------- | --------------------- |
| **Vanilla HTML** | Page structure            | Template literals     |
| **Vanilla CSS**  | Styling                   | Claymorphism design   |
| **Vanilla JS**   | Interactivity             | SSE, DOM manipulation |

### Why These Choices?

**Hono**:

- Lightweight and fast
- OpenAI-compatible API design
- Excellent TypeScript support
- Built-in streaming support

**Playwright**:

- Reliable browser automation
- Multi-browser support
- Excellent API for web scraping
- Active development

**TypeScript**:

- Type safety
- Better IDE support
- Catch errors at compile time
- Self-documenting code

## Design Decisions

### 1. Browser Automation vs. Direct API

**Decision**: Use browser automation (Playwright) instead of direct Qwen API.

**Rationale**:

- Qwen doesn't provide a public API
- Web interface is the only access method
- Browser automation provides full feature access
- Can handle authentication and session management

**Tradeoffs**:

- Higher resource usage (browser instances)
- More complex error handling
- Slower than direct API would be
- Requires browser maintenance

### 2. Multi-Account Rotation

**Decision**: Support multiple Qwen accounts with automatic rotation.

**Rationale**:

- Bypass per-account rate limits
- Increase overall throughput
- Provide failover on errors
- Load balance across accounts

**Tradeoffs**:

- Requires managing multiple accounts
- More complex session management
- Need to track account health
- Potential for account conflicts

### 3. Echo Detection Algorithm

**Decision**: Use bidirectional containment with shingle analysis.

**Rationale**:

- More accurate than simple string matching
- Handles paraphrasing correctly
- Low false positive rate
- Works with streaming responses

**Tradeoffs**:

- More computationally expensive
- Requires tuning thresholds
- May miss some echoes
- Complex to implement correctly

### 4. Configuration System

**Decision**: Three-tier configuration (env → config.json → defaults).

**Rationale**:

- Flexibility for different deployments
- Runtime configuration changes
- Persistent settings across restarts
- Sensible defaults for quick start

**Tradeoffs**:

- More complex than single source
- Need to document priority
- Potential for confusion
- Requires validation logic

## Scalability

### Horizontal Scaling

**Strategy**: Run multiple Qwen Gate instances behind a load balancer.

```
Load Balancer (nginx)
    │
    ├─► Qwen Gate Instance 1
    │
    ├─► Qwen Gate Instance 2
    │
    └─► Qwen Gate Instance 3


**Considerations**:

- Session affinity for stateful requests
- Shared configuration (Redis or database)
- Distributed rate limiting
- Health checks and failover

### Vertical Scaling

**Strategy**: Increase resources on a single instance.

**Optimizations**:

- Increase session pool size
- Add more CPU cores
- Increase memory for browser instances
- Use faster storage for logs

**Limits**:

- Browser instances are CPU-intensive
- Memory usage grows with sessions
- Single point of failure
- Network bandwidth limits

### Performance Characteristics

| Metric              | Single Instance | Scaled (3 instances) |
| ------------------- | --------------- | -------------------- |
| Concurrent requests | 50-100          | 150-300              |
| Requests/second     | 10-20           | 30-60                |
| Average latency     | 2-5s            | 2-5s                 |
| Memory usage        | 2-4 GB          | 6-12 GB              |
| CPU usage           | 2-4 cores       | 6-12 cores           |

## Security Architecture

### Authentication

```

Client Request
│
▼
┌─────────────────┐
│ API Key Check   │ Verify Authorization header
└────────┬────────┘
│
▼
┌─────────────────┐
│ Rate Limiter    │ Check request rate
└────────┬────────┘
│
▼
┌─────────────────┐
│ Request Handler │ Process request
└─────────────────┘

```

**API Key Management**:

- Stored in environment or config.json
- 32+ character random keys recommended
- Supports multiple keys for different clients
- Can be disabled for development

### Browser Isolation

**Strategy**: Each session runs in an isolated browser context.

```

Browser Instance
├─► Context 1 (Session A)
│ ├─► Isolated cookies
│ ├─► Isolated storage
│ └─► Isolated cache
│
├─► Context 2 (Session B)
│ ├─► Isolated cookies
│ ├─► Isolated storage
│ └─► Isolated cache
│
└─► Context 3 (Session C)
├─► Isolated cookies
├─► Isolated storage
└─► Isolated cache

````

**Benefits**:

- Prevents cross-session contamination
- Isolates authentication state
- Reduces security risks
- Simplifies cleanup

### Data Protection

**Sensitive Data Handling**:

1. **API Keys**: Never logged or stored in responses
2. **Credentials**: Stored securely, not exposed to clients
3. **Logs**: Sanitized before storage
4. **Memory**: Cleared after use

**Content Filtering**:

- Removes sensitive patterns from responses
- Filters credentials and tokens
- Sanitizes personal information
- Configurable filter rules

### Network Security

**Recommendations**:

1. Use HTTPS in production
2. Place behind reverse proxy
3. Enable firewall rules
4. Use VPN for admin access
5. Regular security updates

**Deployment Security**:

```nginx
# Rate limiting
limit_req_zone $binary_remote_addr zone=api:10m rate=10r/s;

# Security headers
add_header X-Content-Type-Options "nosniff";
add_header X-Frame-Options "SAMEORIGIN";
add_header Strict-Transport-Security "max-age=31536000";

# CORS (if needed)
add_header Access-Control-Allow-Origin "https://yourdomain.com";
````

## Monitoring and Observability

### Metrics

**Application Metrics**:

- Request count and rate
- Response latency (p50, p95, p99)
- Error rate by type
- Session pool utilization
- Account health status

**System Metrics**:

- CPU usage per instance
- Memory usage per session
- Network I/O
- Browser instance count

### Logging

**Log Levels**:

- `error`: Critical failures
- `warn`: Recoverable issues
- `info`: Normal operations
- `debug`: Detailed debugging

**Log Structure**:

```json
{
  "timestamp": "2024-01-15T10:30:00Z",
  "level": "info",
  "component": "session-pool",
  "message": "Session created",
  "data": {
    "sessionId": "abc123",
    "account": "user@example.com",
    "latency": 1234
  }
}
```

### Dashboard Integration

The dashboard provides:

- Real-time request logs
- Session pool status
- Account health overview
- Error tracking
- Performance metrics

## Future Considerations

### Planned Enhancements

1. **Caching Layer**: Cache frequent queries to reduce load
2. **WebSocket Support**: Real-time bidirectional communication
3. **Plugin System**: Extensible middleware and filters
4. **Multi-Model Support**: Support for other AI providers
5. **Advanced Analytics**: Usage patterns and optimization insights

### Architectural Evolution

**Short-term**:

- Improve session reuse
- Optimize browser resource usage
- Improve content filtering strategies

**Long-term**:

- Distributed session storage
- Machine learning for echo detection
- Automatic performance tuning
- Multi-region deployment

## Conclusion

Qwen Gate's architecture balances performance, reliability, and maintainability. The multi-layer design provides clear separation of concerns, while the plugin-based pipeline allows for easy extension. The focus on observability and monitoring ensures operational excellence in production environments.

For implementation details, see:

- [API Reference](API.md)
- [Deployment Guide](DEPLOYMENT.md)
- [Contributing Guide](../CONTRIBUTING.md)
