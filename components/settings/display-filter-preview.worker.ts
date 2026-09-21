import { previewDisplayFilter } from "@/lib/regex-display-filter";

self.onmessage = (event: MessageEvent<{ input: string; mode: "words" | "regex"; sample: string }>) => {
    try {
        self.postMessage({ output: previewDisplayFilter(event.data.input, event.data.mode, event.data.sample), error: "" });
    } catch (error) {
        self.postMessage({ output: event.data.sample, error: error instanceof Error ? error.message : "预览失败" });
    }
};
