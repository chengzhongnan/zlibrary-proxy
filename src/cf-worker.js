export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    
    // === 动态获取当前代理的域名和Origin ===
    const currentHost = url.host;       // 例如: my-worker.username.workers.dev
    const currentOrigin = url.origin;   // 例如: https://my-worker.username.workers.dev

    // === 以下是核心代理逻辑 ===
    
    const realZlibraryUrl = env.ZLIBRARY_DOMAIN || 'z-library.sk';
    const targetUrl = new URL(request.url);
    targetUrl.port = "443";
    targetUrl.hostname = realZlibraryUrl;
    targetUrl.protocol = "https:";

    // 复制并处理请求头
    const headers = new Headers(request.headers);
    
    // 伪装成 Chrome 浏览器
    headers.set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");
    // Referer 必须指向目标 ZLib 域名，否则可能会被反爬拦截
    headers.set("Referer", `https://${realZlibraryUrl}/`);

    // 删除可能暴露 Worker 身份的头
    headers.delete("X-Forwarded-Proto");
    headers.delete("X-Forwarded-For");
    headers.delete("cf-connecting-ip");
    headers.delete("cf-ipcountry");
    headers.delete("cf-ray");
    headers.delete("cf-visitor");

    // 修改请求 Cookie 中的 Domain (将当前域名的 Cookie 映射回 ZLib 域名)
    const cookies = headers.get("cookie");
    if (cookies) {
      const modifiedCookies = cookies.split(";").map((cookie) => {
        return cookie.trim().replace(new RegExp(`domain=${currentHost}`, 'i'), `domain=${realZlibraryUrl}`);
      }).join("; ");
      headers.set("cookie", modifiedCookies);
    }

    const modifiedRequest = new Request(targetUrl, {
      method: request.method,
      headers: headers, 
      body: request.body,
      redirect: "manual" 
    });

    try {
      const response = await fetch(modifiedRequest);

      // 静态资源直接返回，减少处理开销
      const filterUrls = [".woff", ".woff2", ".ttf", ".jpg", ".png", ".svg", ".ico", ".css", ".js"];
      for (let filterUrl of filterUrls) {
        if (request.url.indexOf(filterUrl) > -1) {
          return response;
        }
      }

      const newResponseHeaders = new Headers(response.headers);

      // === 动态处理 Location 重定向 ===
      if (newResponseHeaders.has("location")) {
        let location = newResponseHeaders.get("location");
        if (location !== null && location.includes(realZlibraryUrl)) {
          // 将跳转链接中的 ZLib 域名替换为当前代理域名
          // 使用 replace 而不是直接 set currentOrigin，可以保留跳转的具体路径
          location = location.replace(realZlibraryUrl, currentHost);
          newResponseHeaders.set("location", location);
        }
      }

      // === 动态处理响应 Cookie ===
      const responseCookies = newResponseHeaders.getAll("set-cookie");
      if (responseCookies.length > 0) {
        newResponseHeaders.delete("set-cookie");
        const reg = new RegExp(realZlibraryUrl, "ig");
        responseCookies.forEach((cookie) => {
          // 将 ZLib 设置的 Cookie 域名替换为当前代理域名
          const updatedCookie = cookie.replace(reg, currentHost);
          newResponseHeaders.append("set-cookie", updatedCookie);
        });
      }

      // 如果是 302 重定向，直接返回
      if (response.status === 302) {
        return new Response(null, {
          status: 302,
          headers: newResponseHeaders
        });
      }

      // === 动态处理网页文本替换 ===
      const responseBody = await response.text();
      const modifiedBody = responseBody
        // 替换带协议的完整 URL (https://zlibrary.to -> https://your-worker.dev)
        .replace(
          new RegExp(`https:((//)|(\\/\\/))([a-zA-Z0-9-]+\\.)?${realZlibraryUrl.replaceAll(".", "\\.")}`, "ig"),
          currentOrigin
        )
        // 替换纯文本域名 (zlibrary.to -> your-worker.dev)
        .replace(new RegExp(realZlibraryUrl, "ig"), currentHost);

      return new Response(modifiedBody, {
        status: response.status,
        statusText: response.statusText,
        headers: newResponseHeaders
      });

    } catch (error) {
      return new Response("Proxy Error: " + error.message, { status: 500 });
    }
  }
};
