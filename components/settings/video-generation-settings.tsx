"use client";

import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { Film, Info, Plus, RefreshCw, Trash2, Upload } from "lucide-react";
import type { VideoGenerationSettings as VideoGenerationSettingsType, VideoPreset } from "@/lib/settings-types";
import {
    DEFAULT_VIDEO_GENERATION_SETTINGS,
    DEFAULT_VIDEO_PRESET,
    loadImageGenerationSettings,
    loadVideoGenerationSettings,
    saveVideoGenerationSettings,
} from "@/lib/settings-storage";
import { storeMediaBlob } from "@/lib/media-cache-storage";
import { getVideoGenerationDailyUsage, fetchVideoGenerationModels, inferVideoPresetDefaults } from "@/lib/video-generation-service";
import { Input, Select, Textarea, Toggle } from "@/components/ui/form";
import { Alert } from "@/components/ui/feedback";

const iconStyle = { "--icon-color": "#7C3AED" } as CSSProperties;
const MAX_MOTION_BYTES = 8 * 1024 * 1024;

function newPreset(): VideoPreset {
    return { ...DEFAULT_VIDEO_PRESET, id: `video_preset_${Date.now()}`, name: "新视频方案" };
}

export function VideoGenerationSettings() {
    const [settings, setSettings] = useState<VideoGenerationSettingsType>(DEFAULT_VIDEO_GENERATION_SETTINGS);
    const [imagePresets, setImagePresets] = useState<Array<{ id: string; name: string; baseUrl: string }>>([]);
    const [testing, setTesting] = useState(false);
    const [testResult, setTestResult] = useState("");
    const [testError, setTestError] = useState("");
    const [dailyUsage, setDailyUsage] = useState({ used: 0, limit: 0 });
    const [models, setModels] = useState<string[]>([]);
    const [modelLoading, setModelLoading] = useState(false);
    const [modelError, setModelError] = useState("");
    const fileRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        setSettings(loadVideoGenerationSettings());
        setDailyUsage(getVideoGenerationDailyUsage());
        const image = loadImageGenerationSettings();
        setImagePresets((image.openaiPresets || []).map(preset => ({
            id: preset.id,
            name: preset.name || preset.model,
            baseUrl: preset.baseUrl,
        })));
    }, []);

    useEffect(() => {
        setModels([]);
        setModelError("");
    }, [settings.activePresetId]);

    const persist = useCallback((next: VideoGenerationSettingsType) => {
        setSettings(next);
        saveVideoGenerationSettings(next);
    }, []);

    const update = useCallback((patch: Partial<VideoGenerationSettingsType>) => {
        setSettings(prev => {
            const next = { ...prev, ...patch };
            saveVideoGenerationSettings(next);
            return next;
        });
    }, []);

    const activePreset = settings.presets.find(preset => preset.id === settings.activePresetId) || settings.presets[0];
    const updatePreset = useCallback((patch: Partial<VideoPreset>) => {
        if (!activePreset) return;
        persist({
            ...settings,
            presets: settings.presets.map(preset => preset.id === activePreset.id ? { ...preset, ...patch } : preset),
        });
    }, [activePreset, persist, settings]);

    const handleAddPreset = () => {
        const preset = newPreset();
        persist({ ...settings, presets: [...settings.presets, preset], activePresetId: preset.id });
    };

    const handleRemovePreset = (id: string) => {
        if (settings.presets.length <= 1) return;
        const presets = settings.presets.filter(preset => preset.id !== id);
        persist({
            ...settings,
            presets,
            activePresetId: settings.activePresetId === id ? presets[0].id : settings.activePresetId,
        });
    };

    const handleMotionFile = async (file: File | undefined) => {
        if (!file) return;
        if (file.size > MAX_MOTION_BYTES) {
            setTestError("参考视频超过 8MB，请压缩后再上传，或改用视频链接");
            return;
        }
        const ref = await storeMediaBlob(file, file.type || "video/mp4", "video");
        update({ motionReferenceRef: ref, motionReferenceName: file.name, motionReferenceUrl: undefined });
    };

    const loadModels = async () => {
        if (!activePreset) return;
        setModelLoading(true);
        setModelError("");
        try {
            const list = await fetchVideoGenerationModels(activePreset);
            if (list.length === 0) throw new Error("中转站没有返回模型列表");
            const videoHints = /video|sora|veo|kling|seedance|wan|hailuo|pixverse|runway|vidu|minimax|jimeng|doubao/i;
            const sorted = [...list].sort((a, b) => Number(videoHints.test(b)) - Number(videoHints.test(a)));
            setModels(sorted);
            if (!sorted.includes(activePreset.model)) updatePreset({ model: sorted[0] });
        } catch (error) {
            setModels([]);
            setModelError(error instanceof Error ? error.message : String(error));
        } finally {
            setModelLoading(false);
        }
    };

    const runTest = async () => {
        if (!activePreset) return;
        setTesting(true);
        setTestResult("");
        setTestError("");
        try {
            let extraBody: Record<string, unknown> | undefined;
            if (activePreset.extraParams.trim()) {
                try {
                    const parsed = JSON.parse(activePreset.extraParams) as unknown;
                    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
                        throw new Error("必须是 JSON 对象");
                    }
                    extraBody = parsed as Record<string, unknown>;
                } catch {
                    throw new Error("高级请求参数不是合法的 JSON 对象");
                }
            }
            const response = await fetch("/api/video-generation", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    baseUrl: activePreset.baseUrl,
                    apiKey: activePreset.apiKey,
                    model: activePreset.model,
                    prompt: "测试：一个角色站在窗边对着镜头挥手，固定机位，半身景",
                    duration: activePreset.duration,
                    ratio: activePreset.ratio,
                    resolution: activePreset.resolution,
                    fps: activePreset.fps,
                    imageField: activePreset.imageField,
                    extraBody,
                    endpointMode: activePreset.endpointMode,
                }),
            });
            const data = await response.json().catch(() => ({})) as { error?: string; status?: string; taskId?: string; videoUrl?: string };
            if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
            if (data.videoUrl) {
                setTestResult("接口连通，已直接返回视频地址。");
            } else if (data.taskId) {
                setTestResult(`接口连通，已创建任务：${data.taskId}（正式生成需等任务完成）`);
            } else {
                setTestResult("接口返回成功，但没有任务 ID 或视频地址，请检查中转站兼容性。");
            }
        } catch (error) {
            setTestError(error instanceof Error ? error.message : String(error));
        } finally {
            setTesting(false);
        }
    };

    return (
        <div className="flex flex-col gap-6 pb-8">
            <div className="flex items-center">
                <h2 className="m-0 mx-2 ts-28 font-bold italic leading-none text-black">Video Generation</h2>
            </div>

            <div className="menu-group">
                <div className="menu-item">
                    <span className="card-icon" style={iconStyle}><Film size={22} strokeWidth={1.75} /></span>
                    <span className="settings-tools-menu-copy">
                        <span className="menu-label appearance-menu-item-label">启用视频生成</span>
                        <span className="menu-desc settings-tools-menu-desc">角色输出 [视频:描述] / [动图:描述] 时调用视频接口。仅线上聊天生效。</span>
                    </span>
                    <span className="menu-right settings-tools-menu-toggle">
                        <Toggle checked={settings.enabled} onChange={(enabled) => update({ enabled })} className="settings-toggle-control" />
                    </span>
                </div>
                <div className="menu-item">
                    <span className="settings-tools-menu-copy">
                        <span className="menu-label appearance-menu-item-label">浏览器直连中转站</span>
                        <span className="menu-desc settings-tools-menu-desc">请求由手机直接发往中转站，绕开 Vercel 4.5MB 请求体限制；跨域失败会自动回退服务端代理。带参考视频时需要开启。</span>
                    </span>
                    <span className="menu-right settings-tools-menu-toggle">
                        <Toggle checked={settings.directMode} onChange={(directMode) => update({ directMode })} className="settings-toggle-control" />
                    </span>
                </div>
                <div className="menu-item">
                    <span className="settings-tools-menu-copy">
                        <span className="menu-label appearance-menu-item-label">强制锁脸</span>
                        <span className="menu-desc settings-tools-menu-desc">参考图取自「图像生成 API」里对应角色的角色参考图；聊天中由发消息的角色自动决定，这里不用选角色。没有参考图会直接报错且不发起请求。</span>
                    </span>
                    <span className="menu-right settings-tools-menu-toggle">
                        <Toggle checked={true} onChange={() => {}} disabled className="settings-toggle-control" />
                    </span>
                </div>
                <div className="menu-item">
                    <span className="settings-tools-menu-copy">
                        <span className="menu-label appearance-menu-item-label">同时使用用户参考图</span>
                        <span className="menu-desc settings-tools-menu-desc">用户参考图按该角色绑定的用户身份自动匹配（配置绑定 → 用户身份），缺图时会报错。</span>
                    </span>
                    <span className="menu-right settings-tools-menu-toggle">
                        <Toggle
                            checked={settings.includeUserReference}
                            onChange={(includeUserReference) => {
                                if (!activePreset) {
                                    update({ includeUserReference });
                                    return;
                                }
                                // 勾选用户参考图时，自动补好该模型需要单独发送参考图的字段名。
                                const needsField = includeUserReference
                                    && activePreset.imageField === "image"
                                    && !activePreset.userReferenceField.trim();
                                if (!needsField) {
                                    update({ includeUserReference });
                                    return;
                                }
                                persist({
                                    ...settings,
                                    includeUserReference,
                                    presets: settings.presets.map(preset => preset.id === activePreset.id
                                        ? { ...preset, userReferenceField: "reference_image" }
                                        : preset),
                                });
                            }}
                            className="settings-toggle-control"
                        />
                    </span>
                </div>
            </div>

            <div className="menu-group p-4 flex flex-col gap-4">
                <div className="menu-item" style={{ padding: 0 }}>
                    <span className="settings-tools-menu-copy">
                        <span className="menu-label appearance-menu-item-label">复用生图中转站</span>
                        <span className="menu-desc settings-tools-menu-desc">开启后沿用「图像生成 API」的地址与 Key，模型仍用下面的视频模型。</span>
                    </span>
                    <span className="menu-right settings-tools-menu-toggle">
                        <Toggle checked={settings.inheritImageApi} onChange={(inheritImageApi) => update({ inheritImageApi })} className="settings-toggle-control" />
                    </span>
                </div>
                {settings.inheritImageApi && (
                    <div className="flex flex-col gap-1">
                        <label className="menu-desc ml-1">继承哪个生图预设</label>
                        <Select
                            value={settings.inheritImagePresetId || ""}
                            onChange={(event) => update({ inheritImagePresetId: event.target.value || undefined })}
                        >
                            <option value="">跟随当前激活的生图预设</option>
                            {imagePresets.map(preset => (
                                <option key={preset.id} value={preset.id}>{preset.name}（{preset.baseUrl}）</option>
                            ))}
                        </Select>
                    </div>
                )}
            </div>

            <div className="menu-group p-4 flex flex-col gap-4">
                <div className="flex items-end gap-2">
                    <div className="flex flex-col gap-1 flex-1">
                        <label className="menu-desc ml-1">视频方案（支持多个中转站）</label>
                        <Select value={settings.activePresetId} onChange={(event) => update({ activePresetId: event.target.value })}>
                            {settings.presets.map(preset => (
                                <option key={preset.id} value={preset.id}>{preset.name}</option>
                            ))}
                        </Select>
                    </div>
                    <button className="ui-btn ui-btn-outline" onClick={handleAddPreset} title="新增方案"><Plus size={16} />新增</button>
                    <button
                        className="ui-btn ui-btn-outline"
                        onClick={() => activePreset && handleRemovePreset(activePreset.id)}
                        disabled={settings.presets.length <= 1}
                        title="删除当前方案"
                    ><Trash2 size={16} /></button>
                </div>

                {activePreset && (
                    <>
                        <div className="flex flex-col gap-1">
                            <label className="menu-desc ml-1">方案名称</label>
                            <Input value={activePreset.name} onChange={(event) => updatePreset({ name: event.target.value })} />
                        </div>
                        <div className="flex flex-col gap-1">
                            <label className="menu-desc ml-1">API 地址（与生图一样填中转站 /v1 地址）</label>
                            <Input
                                value={activePreset.baseUrl}
                                placeholder="https://your-relay.com/v1"
                                onChange={(event) => updatePreset({ baseUrl: event.target.value })}
                            />
                        </div>
                        <div className="flex flex-col gap-1">
                            <label className="menu-desc ml-1">API Key</label>
                            <Input
                                value={activePreset.apiKey}
                                placeholder="sk-..."
                                onChange={(event) => updatePreset({ apiKey: event.target.value })}
                            />
                        </div>
                        <div className="flex flex-col gap-1">
                            <label className="menu-desc ml-1">视频模型</label>
                            <div className="flex gap-2">
                                <Input
                                    value={activePreset.model}
                                    placeholder="sora-2 / veo3 / kling-v2 ..."
                                    onChange={(event) => updatePreset({ model: event.target.value })}
                                />
                                <button
                                    className="ui-btn ui-btn-outline"
                                    onClick={loadModels}
                                    disabled={modelLoading || !activePreset.baseUrl || !activePreset.apiKey}
                                >
                                    {modelLoading ? <RefreshCw size={16} className="animate-spin" /> : <RefreshCw size={16} />}
                                    {modelLoading ? "拉取中…" : "拉取模型"}
                                </button>
                            </div>
                            {modelError && <span className="ts-12" style={{ color: "var(--c-danger, #e5484d)" }}>{modelError}</span>}
                            {models.length > 0 && (
                                <Select
                                    value={activePreset.model}
                                    onChange={(event) => updatePreset({ model: event.target.value, ...inferVideoPresetDefaults(event.target.value) })}
                                >
                                    {!models.includes(activePreset.model) && <option value={activePreset.model}>{activePreset.model}</option>}
                                    {models.map(model => <option key={model} value={model}>{model}</option>)}
                                </Select>
                            )}
                            <button
                                className="ui-btn ui-btn-ghost self-start"
                                onClick={() => updatePreset(inferVideoPresetDefaults(activePreset.model))}
                                disabled={!activePreset.model.trim()}
                            >
                                按模型自动配置（端点 / 帧率 / 首帧字段）
                            </button>
                            <div className="ml-1 ts-12 leading-relaxed" style={{ opacity: 0.62 }}>
                                将发送：{activePreset.model.trim() || "（未选模型）"} · {activePreset.duration}s · {activePreset.ratio} · {activePreset.resolution} · {activePreset.fps}fps · 首帧字段 {activePreset.imageField.trim() || "image"}
                                <br />
                                {activePreset.supportsMotionReference
                                    ? `动作参考字段：${activePreset.motionReferenceField.trim() || "video_url"}`
                                    : "动作参考：未启用（勾选「支持参考视频」后才会发送）"}
                                {settings.includeUserReference && activePreset.imageField !== "image"
                                    ? " · 用户参考图会合并进首帧一起发送"
                                    : ""}
                            </div>
                        </div>
                        <div className="grid grid-cols-2 gap-2">
                            <div className="flex flex-col gap-1">
                                <label className="menu-desc ml-1">时长（秒）</label>
                                <Input
                                    type="number"
                                    min={5}
                                    max={13}
                                    value={activePreset.duration}
                                    onChange={(event) => updatePreset({ duration: Math.min(13, Math.max(5, Number(event.target.value) || 8)) })}
                                />
                            </div>
                            <div className="flex flex-col gap-1">
                                <label className="menu-desc ml-1">比例</label>
                                <Select value={activePreset.ratio} onChange={(event) => updatePreset({ ratio: event.target.value as VideoPreset["ratio"] })}>
                                    <option value="16:9">16:9</option>
                                    <option value="9:16">9:16</option>
                                    <option value="1:1">1:1</option>
                                </Select>
                            </div>
                        </div>
                        <div className="grid grid-cols-2 gap-2">
                            <div className="flex flex-col gap-1">
                                <label className="menu-desc ml-1">分辨率（New API 系必填）</label>
                                <Select value={activePreset.resolution} onChange={(event) => updatePreset({ resolution: event.target.value })}>
                                    <option value="480p">480p</option>
                                    <option value="720p">720p</option>
                                    <option value="1080p">1080p</option>
                                </Select>
                            </div>
                            <div className="flex flex-col gap-1">
                                <label className="menu-desc ml-1">端点风格（iliu.ai 选自动）</label>
                                <Select value={activePreset.endpointMode} onChange={(event) => updatePreset({ endpointMode: event.target.value as VideoPreset["endpointMode"] })}>
                                    <option value="auto">自动尝试</option>
                                    <option value="generations">/videos/generations</option>
                                    <option value="sora">/videos</option>
                                </Select>
                            </div>
                        </div>
                        <div className="grid grid-cols-2 gap-2">
                            <div className="flex flex-col gap-1">
                                <label className="menu-desc ml-1">帧率 fps（Sora 自动 30，其余 24）</label>
                                <Input
                                    type="number"
                                    min={8}
                                    max={60}
                                    value={activePreset.fps}
                                    onChange={(event) => updatePreset({ fps: Math.min(60, Math.max(8, Number(event.target.value) || 24)) })}
                                />
                            </div>
                            <div className="flex flex-col gap-1">
                                <label className="menu-desc ml-1">首帧参考图字段名</label>
                                <Input
                                    value={activePreset.imageField}
                                    placeholder="image / input_reference"
                                    onChange={(event) => updatePreset({ imageField: event.target.value })}
                                />
                            </div>
                        </div>
                        <div className="flex flex-col gap-1">
                            <label className="menu-desc ml-1">参考视频字段名（动作参考，按中转站文档填）</label>
                            <Input
                                value={activePreset.motionReferenceField}
                                placeholder="video_url"
                                onChange={(event) => updatePreset({ motionReferenceField: event.target.value })}
                            />
                        </div>
                        <div className="menu-item" style={{ padding: 0 }}>
                            <span className="settings-tools-menu-copy">
                                <span className="menu-label appearance-menu-item-label">该中转站支持参考视频</span>
                                <span className="menu-desc settings-tools-menu-desc">关闭时如果配置了参考视频会直接报错，不会发起请求。</span>
                            </span>
                            <span className="menu-right settings-tools-menu-toggle">
                                <Toggle
                                    checked={activePreset.supportsMotionReference}
                                    onChange={(supportsMotionReference) => updatePreset({
                                        supportsMotionReference,
                                        ...(supportsMotionReference && !activePreset.motionReferenceField.trim()
                                            ? { motionReferenceField: "video_url" }
                                            : {}),
                                    })}
                                    className="settings-toggle-control"
                                />
                            </span>
                        </div>
                        <div className="menu-item" style={{ padding: 0 }}>
                            <span className="settings-tools-menu-copy">
                                <span className="menu-label appearance-menu-item-label">背景保持清晰（不虚化）</span>
                                <span className="menu-desc settings-tools-menu-desc">开启后提示词会明确要求背景清晰、不要散景；部分模型仍有默认人像虚化，只能降低概率。</span>
                            </span>
                            <span className="menu-right settings-tools-menu-toggle">
                                <Toggle
                                    checked={activePreset.keepBackgroundSharp}
                                    onChange={(keepBackgroundSharp) => updatePreset({ keepBackgroundSharp })}
                                    className="settings-toggle-control"
                                />
                            </span>
                        </div>
                        <div className="flex flex-col gap-1">
                            <label className="menu-desc ml-1">用户参考图字段名（留空默认 reference_image；两人同框时会自动合成参考板）</label>
                            <Input
                                value={activePreset.userReferenceField}
                                placeholder="reference_image"
                                onChange={(event) => updatePreset({ userReferenceField: event.target.value })}
                            />
                        </div>
                        <div className="flex flex-col gap-1">
                            <label className="menu-desc ml-1">高级请求参数（JSON，可选；合并进请求体并覆盖同名项，值填 null 可删除该字段）</label>
                            <Textarea
                                value={activePreset.extraParams}
                                rows={3}
                                placeholder={'例如：{"mode":"std","cfg_scale":0.5}'}
                                onChange={(event) => updatePreset({ extraParams: event.target.value })}
                            />
                        </div>
                        <div className="flex flex-col gap-1">
                            <label className="menu-desc ml-1">额外提示词（可选，每条视频都会追加）</label>
                            <Textarea
                                value={activePreset.extraPrompt}
                                rows={3}
                                placeholder="例如：电影感、柔和补光、皮肤质感真实"
                                onChange={(event) => updatePreset({ extraPrompt: event.target.value })}
                            />
                        </div>
                    </>
                )}
            </div>

            <div className="menu-group p-4 flex flex-col gap-4">
                <div className="flex flex-col gap-1">
                    <label className="menu-desc ml-1">动作参考视频（可选，≤8MB；角色生成时会参考它的动作节奏）</label>
                    <div className="flex items-center gap-2">
                        <button className="ui-btn ui-btn-outline" onClick={() => fileRef.current?.click()}>
                            <Upload size={16} />上传参考视频
                        </button>
                        {settings.motionReferenceName && (
                            <button className="ui-btn ui-btn-ghost" onClick={() => update({ motionReferenceRef: undefined, motionReferenceName: undefined })}>
                                移除：{settings.motionReferenceName}
                            </button>
                        )}
                    </div>
                    <input
                        ref={fileRef}
                        type="file"
                        accept="video/*"
                        className="hidden"
                        onChange={(event) => { void handleMotionFile(event.target.files?.[0]); event.target.value = ""; }}
                    />
                </div>
                <div className="flex flex-col gap-1">
                    <label className="menu-desc ml-1">或直接填参考视频链接</label>
                    <Input
                        value={settings.motionReferenceUrl || ""}
                        placeholder="https://.../reference.mp4"
                        onChange={(event) => update({ motionReferenceUrl: event.target.value || undefined })}
                    />
                </div>
            </div>

            <div className="menu-group p-4 flex flex-col gap-4">
                <div className="grid grid-cols-2 gap-2">
                    <div className="flex flex-col gap-1">
                        <label className="menu-desc ml-1">每日最多生成条数（0=不限）</label>
                        <Input
                            type="number"
                            min={0}
                            max={999}
                            value={settings.maxDailyGenerations}
                            onChange={(event) => update({ maxDailyGenerations: Math.max(0, Math.min(999, Number(event.target.value) || 0)) })}
                        />
                    </div>
                    <div className="flex flex-col gap-1">
                        <label className="menu-desc ml-1">单次最长等待（秒）</label>
                        <Input
                            type="number"
                            min={60}
                            max={900}
                            value={settings.timeoutSeconds}
                            onChange={(event) => update({ timeoutSeconds: Math.max(60, Math.min(900, Number(event.target.value) || 300)) })}
                        />
                    </div>
                </div>
                <div className="flex items-center gap-2">
                    <button className="ui-btn ui-btn-primary" onClick={runTest} disabled={testing || !activePreset?.baseUrl || !activePreset?.apiKey}>
                        {testing ? <RefreshCw size={16} className="animate-spin" /> : <Film size={16} />}
                        {testing ? "测试中…" : "测试接口连通性"}
                    </button>
                </div>
                {testResult && <Alert variant="success">{testResult}</Alert>}
                {testError && <Alert variant="danger">{testError}</Alert>}
                <div className="menu-desc flex items-start gap-2 opacity-70">
                    <Info size={14} style={{ marginTop: 2 }} />
                    <span>今日已生成 {dailyUsage.used} 条{dailyUsage.limit > 0 ? `（上限 ${dailyUsage.limit} 条）` : "（未设上限）"}。没有参考图时会在调用接口前直接报错，不产生费用。</span>
                </div>
            </div>
        </div>
    );
}
