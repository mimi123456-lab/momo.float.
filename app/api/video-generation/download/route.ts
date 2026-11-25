import { NextRequest, NextResponse } from "next/server";
import { downloadGeneratedVideo } from "@/lib/server-video-download";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function POST(request: NextRequest) {
    const input = await request.json().catch(() => null);
    if (typeof input?.url !== "string" || input.url.length > 40000) {
        return NextResponse.json({ error: "缺少有效视频地址" }, { status: 400 });
    }
    try {
        const { bytes, mimeType } = await downloadGeneratedVideo(input.url, AbortSignal.any([request.signal, AbortSignal.timeout(100_000)]));
        return new Response(bytes as BodyInit, { headers: { "Content-Type": mimeType, "Cache-Control": "no-store" } });
    } catch (error) {
        return NextResponse.json({ error: error instanceof Error ? error.message : "视频下载失败" }, { status: 502 });
    }
}
