/**
 * Cloudflare Workers 反向代理 - 简洁版本
 * 专注于核心代理功能，无特殊API映射
 */

// ============================================
// 配置区域 - 部署时只需修改 wrangler.toml
// ============================================
// 域名会自动从请求中获取，无需手动配置
// ============================================

/**
 * 主请求处理函数
 */
export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      const pathname = url.pathname;

      // 自动获取当前域名
      const PROXY_DOMAIN = url.host;

      // 健康检查
      if (pathname === '/health') {
        return createJSONResponse({ status: 'healthy', timestamp: new Date().toISOString() });
      }

      // 首页
      if (pathname === '/') {
        return createHomeResponse(PROXY_DOMAIN);
      }

      // 基础代理路由（注意：更长的路径要先匹配，避免被短路径提前匹配）
      if (pathname.startsWith('/httpproxyport/')) {
        return await handleProxyPort(request, pathname, 'http');
      }

      if (pathname.startsWith('/proxyport/')) {
        return await handleProxyPort(request, pathname, 'https');
      }

      if (pathname.startsWith('/httpproxy/')) {
        return await handleProxy(request, pathname, 'http');
      }

      if (pathname.startsWith('/proxy/')) {
        return await handleProxy(request, pathname, 'https');
      }

      // HTML重写代理路由
      if (pathname.startsWith('/webproxy/')) {
        return await handleWebProxy(request, pathname, 'https');
      }

      if (pathname.startsWith('/httpwebproxy/')) {
        return await handleWebProxy(request, pathname, 'http');
      }

      // 未匹配到任何路由
      return createErrorResponse('Not Found', 404, 'Invalid route. Supported routes: /proxy/*, /httpproxy/*, /proxyport/*, /httpproxyport/*');

    } catch (error) {
      return createErrorResponse('Internal Server Error', 500, error.message);
    }
  }
};

/**
 * 处理基础代理
 */
async function handleProxy(request, pathname, protocol) {
  const prefix = protocol === 'https' ? '/proxy/' : '/httpproxy/';
  const path = pathname.substring(prefix.length);
  const parts = path.split('/');

  if (parts.length < 1) {
    return createErrorResponse('Bad Request', 400, 'Missing host parameter');
  }

  const host = parts[0];
  const targetPath = parts.slice(1).join('/') || '';
  const url = new URL(request.url);
  const targetUrl = `${protocol}://${host}/${targetPath}${url.search}`;

  return await proxyRequest(request, targetUrl);
}

/**
 * 处理HTML重写代理
 */
async function handleWebProxy(request, pathname, protocol) {
  const prefix = protocol === 'https' ? '/webproxy/' : '/httpwebproxy/';
  const path = pathname.substring(prefix.length);
  const parts = path.split('/');

  if (parts.length < 1) {
    return createErrorResponse('Bad Request', 400, 'Missing host parameter');
  }

  const host = parts[0];
  const targetPath = parts.slice(1).join('/') || '';
  const url = new URL(request.url);
  const targetUrl = `${protocol}://${host}/${targetPath}${url.search}`;

  return await proxyRequestWithRewrite(request, targetUrl, url.origin, prefix);
}

/**
 * 处理带端口代理
 */
async function handleProxyPort(request, pathname, protocol) {
  const prefix = protocol === 'https' ? '/proxyport/' : '/httpproxyport/';
  const path = pathname.substring(prefix.length);
  const parts = path.split('/');

  if (parts.length < 2) {
    return createErrorResponse('Bad Request', 400, 'Missing host or port parameter');
  }

  const host = parts[0];
  const port = parts[1];
  const targetPath = parts.slice(2).join('/') || '';

  // 确保端口是数字且有效
  const portNum = parseInt(port, 10);
  if (isNaN(portNum) || portNum < 1 || portNum > 65535) {
    return createErrorResponse('Bad Request', 400, `Invalid port: ${port}`);
  }

  const url = new URL(request.url);
  const targetUrl = `${protocol}://${host}:${portNum}/${targetPath}${url.search}`;

  // 添加调试日志
  console.log(`Proxying to: ${targetUrl}`);
  console.log(`Original URL: ${request.url}`);
  console.log(`Host: ${host}, Port: ${portNum}, Path: ${targetPath}`);

  try {
    return await proxyRequest(request, targetUrl);
  } catch (error) {
    console.error(`Proxy error for ${targetUrl}:`, error);
    return createErrorResponse('Proxy Error', 502, `Failed to connect to ${host}:${portNum} - ${error.message}`);
  }
}

/**
 * HTTP/HTTPS代理请求（带HTML重写）
 */
async function proxyRequestWithRewrite(request, targetUrl, proxyOrigin, proxyPrefix) {
  try {
    const headers = buildProxyHeaders(request.headers, targetUrl);
    const proxyRequest = new Request(targetUrl, {
      method: request.method,
      headers: headers,
      body: request.method !== 'GET' && request.method !== 'HEAD' ? request.body : null
    });

    const response = await fetch(proxyRequest);
    const contentType = response.headers.get('content-type') || '';

    // 只重写HTML内容
    if (contentType.includes('text/html')) {
      const html = await response.text();
      const targetOrigin = new URL(targetUrl).origin;
      const rewrittenHtml = rewriteHTML(html, targetOrigin, proxyOrigin, proxyPrefix);

      const responseHeaders = buildResponseHeaders(response.headers, true);
      responseHeaders.set('content-type', 'text/html;charset=UTF-8');
      responseHeaders.delete('content-length');

      return new Response(rewrittenHtml, {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders
      });
    }

    // 非HTML内容直接返回
    const responseHeaders = buildResponseHeaders(response.headers, true);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders
    });

  } catch (error) {
    return createErrorResponse('Proxy Error', 502, `Failed to connect to target: ${error.message}`);
  }
}

/**
 * HTTP/HTTPS代理请求
 */
async function proxyRequest(request, targetUrl) {
  try {
    // 构建请求头
    const headers = buildProxyHeaders(request.headers, targetUrl);

    // 添加调试日志
    console.log(`Target URL: ${targetUrl}`);
    console.log(`Host Header: ${headers.get('Host')}`);

    // 构建代理请求
    const proxyRequest = new Request(targetUrl, {
      method: request.method,
      headers: headers,
      body: request.method !== 'GET' && request.method !== 'HEAD' ? request.body : null
    });

    // 发送请求并获取响应
    const response = await fetch(proxyRequest);

    console.log(`Response Status: ${response.status}`);
    console.log(`Response Server: ${response.headers.get('Server')}`);
    console.log(`Response Location: ${response.headers.get('Location')}`);
    console.log(`All Response Headers:`, JSON.stringify([...response.headers.entries()]));

    // 构建响应头
    const responseHeaders = buildResponseHeaders(response.headers);

    // 返回响应
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders
    });

  } catch (error) {
    return createErrorResponse('Proxy Error', 502, `Failed to connect to target: ${error.message}`);
  }
}

/**
 * 重写HTML内容中的URL
 */
function rewriteHTML(html, targetOrigin, proxyOrigin, proxyPrefix) {
  // 替换绝对URL: https://example.com/path -> https://your-domain/webproxy/example.com/path
  html = html.replace(
    new RegExp('(href|src|action)="(https?://[^"]+)"', 'gi'),
    function(match, attr, url) {
      try {
        const urlObj = new URL(url);
        const newUrl = proxyOrigin + proxyPrefix + urlObj.host + urlObj.pathname + urlObj.search + urlObj.hash;
        return attr + '="' + newUrl + '"';
      } catch (e) {
        return match;
      }
    }
  );

  // 替换相对URL: /path -> https://your-domain/webproxy/example.com/path
  html = html.replace(
    new RegExp('(href|src|action)="(/[^"]*)"', 'gi'),
    function(match, attr, path) {
      if (path.startsWith('//')) return match;
      const targetHost = new URL(targetOrigin).host;
      const newUrl = proxyOrigin + proxyPrefix + targetHost + path;
      return attr + '="' + newUrl + '"';
    }
  );

  return html;
}

/**
 * 构建代理请求头
 */
function buildProxyHeaders(originalHeaders, targetUrl) {
  const headers = new Headers();
  const target = new URL(targetUrl);

  // 复制更多请求头，避免被检测
  const importantHeaders = [
    'accept', 'accept-encoding', 'accept-language', 'authorization',
    'content-type', 'user-agent', 'cache-control', 'pragma', 'content-length',
    'origin', 'referer', 'cookie', 'x-requested-with',
  'authorization',           // OpenAI: Bearer sk-xxx
  'x-goog-api-key',          // Gemini: API Key
  'x-api-key',               // 通用 API Key 头（Anthropic/自定义服务）
  'x-openai-api-key',        // 某些 OpenAI 兼容服务
  'Content-Type', 
  ];
  
  for (const [key, value] of originalHeaders.entries()) {
    if (importantHeaders.includes(key.toLowerCase())) {
      headers.set(key, value);
    }
  }

  // 设置目标主机头
  headers.set('Host', target.host);

  // 添加标准浏览器User-Agent，如果原请求没有的话
  if (!headers.has('User-Agent')) {
    headers.set('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  }

  // 不添加代理标识，避免被检测
  // const clientIP = originalHeaders.get('CF-Connecting-IP') || 'unknown';
  // headers.set('X-Forwarded-For', clientIP);
  // headers.set('X-Real-IP', clientIP);

  return headers;
}

/**
 * 构建响应头
 */
function buildResponseHeaders(originalHeaders, isWebProxy = false) {
  const headers = new Headers();

  // 复制重要响应头（移除location，避免被重定向）
  const importantHeaders = [
    'content-type', 'content-encoding', 'content-length', 'cache-control',
    'etag', 'last-modified'
    // 'location' - 不复制location头，避免被服务器端重定向
  ];

  // 对于网页代理，需要传递 set-cookie
  if (isWebProxy) {
    importantHeaders.push('set-cookie');
  }

  for (const [key, value] of originalHeaders.entries()) {
    if (importantHeaders.includes(key.toLowerCase())) {
      headers.set(key, value);
    }
  }

  // 添加CORS支持
  if (!isWebProxy) {
    // 基础代理需要CORS
    headers.set('Access-Control-Allow-Origin', '*');
    headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, HEAD, PATCH');
    headers.set('Access-Control-Allow-Headers', '*');
    headers.set('Access-Control-Max-Age', '86400');
  }

  return headers;
}

/**
 * 创建JSON响应
 */
function createJSONResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status: status,
    headers: {
      'Content-Type': 'application/json;charset=UTF-8',
      'Access-Control-Allow-Origin': '*'
    }
  });
}

/**
 * 创建错误响应
 */
function createErrorResponse(message, status = 500, details = null) {
  const error = {
    error: message,
    code: status,
    timestamp: new Date().toISOString()
  };

  if (details) {
    error.details = details;
  }

  return createJSONResponse(error, status);
}

/**
 * 创建首页响应

function createHomeResponse(proxyDomain) {
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Proxy</title>
    <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>⚡</text></svg>">
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); min-height: 100vh; padding: 15px; }
        .container { max-width: 700px; margin: 20px auto; background: white; padding: 25px; border-radius: 16px; box-shadow: 0 20px 60px rgba(0,0,0,0.3); }
        h1 { color: #333; text-align: center; margin-bottom: 25px; font-size: 32px; font-weight: 600; }
        h2 { color: #667eea; margin: 25px 0 12px 0; font-size: 16px; }
        .input-box { background: #f8f9ff; padding: 15px; border-radius: 10px; margin-bottom: 15px; }
        .input-box input { width: 100%; padding: 12px; border: 2px solid #e0e0e0; border-radius: 8px; font-size: 14px; transition: border 0.3s; }
        .input-box input:focus { outline: none; border-color: #667eea; }
        #proxyLink { margin-top: 12px; padding: 12px; background: #e8f5e9; border-radius: 8px; font-family: 'Courier New', monospace; font-size: 11px; word-break: break-all; display: none; color: #2e7d32; overflow-wrap: break-word; }
        .btn-group { margin-top: 12px; display: flex; gap: 8px; }
        .btn { padding: 12px 20px; border: none; border-radius: 8px; cursor: pointer; font-size: 14px; font-weight: 500; transition: all 0.3s; }
        .btn-primary { background: #667eea; color: white; flex: 1; }
        .btn-primary:hover { background: #5568d3; transform: translateY(-2px); }
        .btn-success { background: #28a745; color: white; display: none; }
        .btn-success:hover { background: #218838; }
        .route { background: #fafafa; padding: 12px; margin: 8px 0; border-radius: 8px; border-left: 3px solid #667eea; font-size: 13px; word-break: break-all; overflow-wrap: break-word; }
        .route strong { color: #333; display: block; margin-bottom: 5px; }
        .route code { background: #e8e8e8; padding: 2px 5px; border-radius: 4px; font-size: 11px; word-break: break-all; }
        .route em { color: #666; font-size: 12px; display: block; margin-top: 5px; word-break: break-all; }
        .footer { text-align: center; margin-top: 30px; color: #999; font-size: 12px; }
        @media (max-width: 600px) {
            body { padding: 10px; }
            .container { padding: 20px; margin: 10px auto; }
            h1 { font-size: 24px; }
            h2 { font-size: 15px; }
            .btn { padding: 10px 16px; font-size: 13px; }
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>⚡ Proxy</h1>

        <h2>🔗 快速访问</h2>
        <div class="input-box">
            <input type="text" id="targetUrl" placeholder="输入目标网址，如：https://api.example.com/users">
            <div id="proxyLink"></div>
            <div class="btn-group">
                <button onclick="goProxy()" class="btn btn-primary">访问</button>
                <button onclick="copyProxy()" id="copyBtn" class="btn btn-success">复制链接</button>
            </div>
        </div>

        <h2>📋 支持的路由</h2>

        <div class="route">
            <strong>HTTPS代理：</strong> <code>/proxy/:host/:path*</code><br>
            <em>示例：</em> https://${proxyDomain}/proxy/httpbin.org/json
        </div>

        <div class="route">
            <strong>HTTP代理：</strong> <code>/httpproxy/:host/:path*</code><br>
            <em>示例：</em> https://${proxyDomain}/httpproxy/httpbin.org/json
        </div>

        <div class="route">
            <strong>带端口代理：</strong> <code>/proxyport/:host/:port/:path*</code> 或 <code>/httpproxyport/:host/:port/:path*</code><br>
            <em>示例：</em> https://${proxyDomain}/httpproxyport/portquiz.net/8080
        </div>

        <div class="route" style="border-left-color: #28a745;">
            <strong>🆕 网页代理（HTML重写）：</strong> <code>/webproxy/:host/:path*</code> 或 <code>/httpwebproxy/:host/:path*</code><br>
            <em>自动重写HTML中的链接，让整个网站通过代理访问</em><br>
            <em>示例：</em> https://${proxyDomain}/webproxy/example.com
        </div>

        <div class="route" style="border-left-color: #f59e0b;">
            <strong>🚀 Git 加速：</strong> 加速 GitHub/GitLab 等仓库克隆<br>
            <em>示例：</em> git clone https://${proxyDomain}/proxy/github.com/QImageLab/cf-proxy.git
        </div>

        <script>
        let currentProxyUrl = '';

        function updateProxyLink() {
            const url = document.getElementById('targetUrl').value.trim();
            const linkDiv = document.getElementById('proxyLink');
            const copyBtn = document.getElementById('copyBtn');

            if (!url) {
                linkDiv.style.display = 'none';
                copyBtn.style.display = 'none';
                return;
            }

            try {
                const parsed = new URL(url);
                const protocol = parsed.protocol === 'https:' ? 'proxy' : 'httpproxy';
                const path = parsed.pathname + parsed.search + parsed.hash;
                let proxyPath;
                if (parsed.port) {
                    proxyPath = '/' + protocol + 'port/' + parsed.hostname + '/' + parsed.port + path;
                } else {
                    proxyPath = '/' + protocol + '/' + parsed.hostname + path;
                }
                currentProxyUrl = window.location.origin + proxyPath;
                linkDiv.textContent = currentProxyUrl;
                linkDiv.style.display = 'block';
                copyBtn.style.display = 'inline-block';
            } catch (e) {
                linkDiv.style.display = 'none';
                copyBtn.style.display = 'none';
            }
        }

        function goProxy() {
            const url = document.getElementById('targetUrl').value.trim();
            if (!url) {
                alert('请输入目标网址');
                return;
            }
            if (currentProxyUrl) {
                window.location.href = currentProxyUrl;
            }
        }

        function copyProxy() {
            if (currentProxyUrl) {
                navigator.clipboard.writeText(currentProxyUrl).then(function() {
                    const btn = document.getElementById('copyBtn');
                    btn.textContent = '已复制!';
                    setTimeout(function() {
                        btn.textContent = '复制链接';
                    }, 2000);
                });
            }
        }

        const input = document.getElementById('targetUrl');
        const copyBtn = document.getElementById('copyBtn');

        input.addEventListener('input', updateProxyLink);
        input.addEventListener('keypress', function(e) {
            if (e.key === 'Enter') goProxy();
        });

        copyBtn.style.display = 'none';
        </script>

        <div class="footer">
            <p>Cloudflare Workers • <a href="https://github.com/QImageLab/cf-proxy" target="_blank" style="color: #667eea; text-decoration: none;">GitHub</a></p>
        </div>
    </div>
</body>
</html>`;

  return new Response(html, {
    headers: {
      'Content-Type': 'text/html;charset=UTF-8',
      'Cache-Control': 'public, max-age=300'
    }
  });
}
 */
