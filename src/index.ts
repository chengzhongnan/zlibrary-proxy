import express, { Request, Response } from 'express'; // 需要安装 @types/express
import path from 'path';
import { fileURLToPath } from 'url';

// 确保 TS 识别 fetch (Node 18+ 内置)
// 如果报错找不到 fetch，请在 tsconfig.json 中添加 "lib": ["DOM", "ES2020"]
declare const fetch: any; 
declare const Headers: any;
declare const Request: any;

const app = express();

// 禁用 Express 默认的 Body 解析
app.use(express.raw({ type: '*/*', limit: '10mb' }));

app.all('*', async (req: Request, res: Response) => {
  try {
    // === 动态获取当前代理的域名和Origin ===
    const currentHost = req.headers.host || 'localhost';
    const protocol = req.headers['x-forwarded-proto'] || 'https';
    const currentOrigin = `${protocol}://${currentHost}`; 

    // === 目标配置 ===
    const realZlibraryUrl = process.env.ZLIBRARY_DOMAIN || 'z-library.sk';
    
    // 构建目标 URL
    const targetUrlString = `https://${realZlibraryUrl}${req.url}`;
    const targetUrl = new URL(targetUrlString);

    // === 处理请求头 ===
    const headers = new Headers();
    
    // 修复 TS2345 错误的部分
    Object.keys(req.headers).forEach(key => {
      if (['host', 'connection', 'content-length'].includes(key)) return;
      
      const value = req.headers[key];
      if (value) {
        // 如果是数组则 join，否则直接用
        headers.set(key, Array.isArray(value) ? value.join(', ') : value);
      }
    });

    // 伪装成 Chrome
    headers.set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");
    headers.set("Referer", `https://${realZlibraryUrl}/`);

    // 删除暴露身份的头
    headers.delete("X-Forwarded-Proto");
    headers.delete("X-Forwarded-For");
    headers.delete("X-Real-IP");

    // === 修改请求 Cookie ===
    const cookieHeader = req.headers['cookie'];
    if (cookieHeader) {
      const modifiedCookies = cookieHeader.split(";").map((cookie) => {
        return cookie.trim().replace(new RegExp(`domain=${currentHost}`, 'i'), `domain=${realZlibraryUrl}`);
      }).join("; ");
      headers.set("cookie", modifiedCookies);
    }

    // === 发起请求 ===
    const requestBody = ['GET', 'HEAD'].includes(req.method) ? null : req.body;

    const response = await fetch(targetUrl, {
      method: req.method,
      headers: headers,
      body: requestBody,
      redirect: "manual"
    });

    // === 处理响应头 ===
    const newResponseHeaders = new Headers(response.headers);
    
    // 1. 处理 Location 重定向
    if (newResponseHeaders.has("location")) {
      let location = newResponseHeaders.get("location");
      if (location && location.includes(realZlibraryUrl)) {
        location = location.replace(realZlibraryUrl, currentHost);
        location = location.replace(`https://${currentHost}`, currentOrigin);
        res.setHeader("location", location);
      } else if (location) {
          res.setHeader("location", location);
      }
    }

    // 2. 处理 Set-Cookie (兼容性处理)
    // TypeScript 可能报错 getSetCookie 不存在，因此我们用类型断言或 fallback
    let setCookies: string[] = [];
    if (typeof (response.headers as any).getSetCookie === 'function') {
        setCookies = (response.headers as any).getSetCookie();
    } else {
        const sc = response.headers.get('set-cookie');
        if (sc) setCookies = [sc];
    }

    if (setCookies.length > 0) {
      const reg = new RegExp(realZlibraryUrl, "ig");
      const updatedCookies = setCookies.map(cookie => {
        return cookie.replace(reg, currentHost);
      });
      updatedCookies.forEach(c => res.append('set-cookie', c));
    }

    // 复制其他普通响应头
    (response.headers as any).forEach((value: string, key: string) => {
      if (['content-encoding', 'content-length', 'transfer-encoding', 'location', 'set-cookie'].includes(key)) return;
      res.setHeader(key, value);
    });

    res.status(response.status);

    if (response.status === 302) {
      res.end();
      return;
    }

    // === 处理响应体 ===
    const filterUrls = [".woff", ".woff2", ".ttf", ".jpg", ".png", ".svg", ".ico", ".css", ".js"];
    const isStatic = filterUrls.some(ext => req.path.endsWith(ext));

    if (isStatic) {
      const arrayBuffer = await response.arrayBuffer();
      res.send(Buffer.from(arrayBuffer));
      return;
    }

    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('text') || contentType.includes('json') || contentType.includes('xml')) {
        let responseBody = await response.text();
        responseBody = responseBody
            .replace(
            new RegExp(`https:((//)|(\\/\\/))([a-zA-Z0-9-]+\\.)?${realZlibraryUrl.replaceAll(".", "\\.")}`, "ig"),
            currentOrigin
            )
            .replace(new RegExp(realZlibraryUrl, "ig"), currentHost);

        res.send(responseBody);
    } else {
        const arrayBuffer = await response.arrayBuffer();
        res.send(Buffer.from(arrayBuffer));
    }

  } catch (error: any) {
    console.error("Proxy Error:", error);
    res.status(500).send("Proxy Error: " + error.message);
  }
});

export default app;
