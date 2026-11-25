import { createHash, createHmac } from "node:crypto";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

/**
 * 腾讯云 COS PUT Object 签名（签名算法 v5）。
 * 浏览器拿到签名后直传 COS，绕开 Vercel 4.5MB 请求体上限。
 * 文档：https://cloud.tencent.com/document/product/436/7778
 */

function hmacSha1Hex(key: string, message: string): string {
    return createHmac("sha1", key).update(message, "utf8").digest("hex");
}

function sha1Hex(message: string): string {
    return createHash("sha1").update(message, "utf8").digest("hex");
}

/** COS 规定的 UrlEncode：除 A-Za-z0-9-_.~ 外全部百分号编码。 */
function cosUrlEncode(value: string): string {
    return encodeURIComponent(value).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

type SignBody = {
    secretId?: string;
    secretKey?: string;
    bucket?: string;
    region?: string;
    key?: string;
    contentType?: string;
};

export async function POST(request: Request) {
    let body: SignBody;
    try {
        body = await request.json() as SignBody;
    } catch {
        return NextResponse.json({ error: "请求体不是合法 JSON" }, { status: 400 });
    }

    const secretId = body.secretId?.trim() || "";
    const secretKey = body.secretKey?.trim() || "";
    const bucket = body.bucket?.trim() || "";
    const region = body.region?.trim() || "";
    const key = (body.key || "").replace(/^\/+/, "");
    const contentType = body.contentType?.trim() || "application/octet-stream";

    if (!secretId || !secretKey || !bucket || !region || !key) {
        return NextResponse.json({ error: "COS 配置不完整（SecretId/SecretKey/Bucket/Region/对象键）" }, { status: 400 });
    }

    const host = `${bucket}.cos.${region}.myqcloud.com`;
    // 对象键只用安全字符，保证签名里的 UriPathname 与实际请求路径一致。
    const pathname = `/${key}`;
    const now = Math.floor(Date.now() / 1000);
    const keyTime = `${now};${now + 3600}`;

    // 参与签名的请求头：小写、按字典序；HttpHeaders 是 key=urlencode(value)&... 形式（不是仅仅列头名）。
    const headerList = "content-type;host";
    const httpHeaders = `content-type=${cosUrlEncode(contentType)}&host=${cosUrlEncode(host)}`;
    const httpString = `put\n${pathname}\n\n${httpHeaders}\n`;
    const stringToSign = `sha1\n${keyTime}\n${sha1Hex(httpString)}\n`;
    const signKey = hmacSha1Hex(secretKey, keyTime);
    const signature = hmacSha1Hex(signKey, stringToSign);

    const authorization = [
        "q-sign-algorithm=sha1",
        `q-ak=${secretId}`,
        `q-sign-time=${keyTime}`,
        `q-key-time=${keyTime}`,
        `q-header-list=${headerList}`,
        "q-url-param-list=",
        `q-signature=${signature}`,
    ].join("&");

    return NextResponse.json({
        url: `https://${host}${pathname}`,
        headers: {
            Authorization: authorization,
            "Content-Type": contentType,
        },
        publicUrl: `https://${host}${pathname}`,
    });
}
