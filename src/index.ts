import express from 'express'
import path from 'path'
import { fileURLToPath } from 'url'
// Node 18+ 原生支持 fetch，如果 Vercel 环境较老可能需要安装 node-fetch，
// 但现在 Vercel 默认环境通常都支持。

const app = express()

// 禁用 Express 默认的 Body 解析，以便直接转发原始 Body
// 如果你需要处理 POST 请求的 Body，这一点很重要
app.use(express.raw({ type: '*/*', limit: '10mb' }));

// 核心代理逻辑：捕获所有方法和所有路径
app.all('*', async (req, res) => {
  try {
    // === 动态获取当前代理的域名和Origin ===
    const currentHost = req.headers.host; // 例如: your-project.vercel.app
    const protocol = req.headers['x-forwarded-proto'] || 'https';
    const currentOrigin = `${protocol}://${currentHost}`; 

    // === 目标配置 ===
    // 在 Vercel 后台配置环境变量 ZLIBRARY_DOMAIN，或者使用默认值
    const realZlibraryUrl = process.env.ZLIBRARY_DOMAIN || 'z-library.sk';
    
    // 构建目标 URL
    // req.url 包含了路径和查询参数 (e.g. /s/book?q=test)
    const targetUrlString = `https://${realZlibraryUrl}${req.url}`;
    const targetUrl = new URL(targetUrlString);

    // === 处理请求头 ===
    const headers = new Headers();
    
    // 复制原始请求头
    Object.keys(req.headers).forEach(key => {
      // 排除 Node/Express 特有或需要剔除的头
      if (['host', 'connection', 'content-length'].includes(key)) return;
      headers.set(key, req.headers[key]);
    });

    // 伪装成 Chrome
    headers.set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");
    headers.set("Referer", `https://${realZlibraryUrl}/`);

    // 删除暴露身份的头
    headers.delete("X-Forwarded-Proto");
    headers.delete("X-Forwarded-For");
    headers.delete("X-Real-IP");

    // === 修改请求 Cookie ===
    // 注意：浏览器发送到服务器的 Cookie 只有 key=value，通常不包含 Domain 属性。
    // 这里主要做简单的透传，原有的 Domain 替换逻辑在 Request 阶段其实很少生效，
    // 但为了保持逻辑一致，我们保留替换尝试。
    const cookieHeader = req.headers['cookie'];
    if (cookieHeader) {
      const modifiedCookies = cookieHeader.split(";").map((cookie) => {
        return cookie.trim().replace(new RegExp(`domain=${currentHost}`, 'i'), `domain=${realZlibraryUrl}`);
      }).join("; ");
      headers.set("cookie", modifiedCookies);
    }

    // === 发起请求 ===
    // 如果是 GET/HEAD 请求，body 必须为 null
    const requestBody = ['GET', 'HEAD'].includes(req.method) ? null : req.body;

    const response = await fetch(targetUrl, {
      method: req.method,
      headers: headers,
      body: requestBody,
      redirect: "manual" // 禁止自动跟随重定向，以便我们处理 Location
    });

    // === 处理响应头 ===
    const newResponseHeaders = new Headers(response.headers);
    
    // 1. 处理 Location 重定向
    if (newResponseHeaders.has("location")) {
      let location = newResponseHeaders.get("location");
      if (location && location.includes(realZlibraryUrl)) {
        location = location.replace(realZlibraryUrl, currentHost);
        // 如果 location 是绝对路径但协议是 https，可能需要确保指向当前协议
        location = location.replace(`https://${currentHost}`, currentOrigin);
        res.setHeader("location", location);
      } else if (location) {
          res.setHeader("location", location);
      }
    }

    // 2. 处理 Set-Cookie
    // Node fetch API 获取 Set-Cookie 有时需要用 getSetCookie() (Node 18+)
    const setCookies = typeof response.headers.getSetCookie === 'function' 
        ? response.headers.getSetCookie() 
        : (response.headers.get('set-cookie') ? [response.headers.get('set-cookie')] : []);

    if (setCookies.length > 0) {
      const reg = new RegExp(realZlibraryUrl, "ig");
      const updatedCookies = setCookies.map(cookie => {
        // 替换 Domain
        return cookie.replace(reg, currentHost);
      });
      // Express 使用 res.append 设置多个同名 Header
      updatedCookies.forEach(c => res.append('set-cookie', c));
    }

    // 复制其他普通响应头
    response.headers.forEach((value, key) => {
      if (['content-encoding', 'content-length', 'transfer-encoding', 'location', 'set-cookie'].includes(key)) return;
      res.setHeader(key, value);
    });

    // === 设置状态码 ===
    res.status(response.status);

    // 如果是 302 重定向，直接结束
    if (response.status === 302) {
      return res.end();
    }

    // === 处理响应体 ===
    // 静态资源直接透传
    const filterUrls = [".woff", ".woff2", ".ttf", ".jpg", ".png", ".svg", ".ico", ".css", ".js"];
    const isStatic = filterUrls.some(ext => req.path.endsWith(ext));

    if (isStatic) {
      // 将 ArrayBuffer 转换为 Buffer 发送
      const arrayBuffer = await response.arrayBuffer();
      return res.send(Buffer.from(arrayBuffer));
    }

    // 文本/HTML 替换逻辑
    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('text') || contentType.includes('json') || contentType.includes('xml')) {
        let responseBody = await response.text();
        
        responseBody = responseBody
            // 替换带协议的完整 URL
            .replace(
            new RegExp(`https:((//)|(\\/\\/))([a-zA-Z0-9-]+\\.)?${realZlibraryUrl.replaceAll(".", "\\.")}`, "ig"),
            currentOrigin
            )
            // 替换纯文本域名
            .replace(new RegExp(realZlibraryUrl, "ig"), currentHost);

        return res.send(responseBody);
    } else {
        // 其他类型二进制文件 (如 pdf, epub 下载)
        const arrayBuffer = await response.arrayBuffer();
        return res.send(Buffer.from(arrayBuffer));
    }

  } catch (error) {
    console.error("Proxy Error:", error);
    res.status(500).send("Proxy Error: " + error.message);
  }
});

export default app
