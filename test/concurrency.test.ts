import { describe, expect, it } from "vitest";
import { ExtractiveGenerator } from "../src/generators/extractive.js";
import { KeyedMutex } from "../src/mutex.js";
import { RagService } from "../src/service.js";
import { InMemoryVectorStore } from "../src/stores/memory.js";
import { expectedIds, latent, raceIngests, slowEmbedder, versionText } from "./helpers/ingest-race.js";

const DIMS = 16;

describe("concurrent ingests of one document", () => {
  it("leave exactly one complete version behind when the store lock is in place", async () => {
    const store = latent(new InMemoryVectorStore(), { lock: true });
    const left = await raceIngests(store, DIMS, [1, 2, 3, 4, 5, 6]);
    const candidates = await Promise.all([1, 2, 3, 4, 5, 6].map((v) => expectedIds(versionText(v), DIMS)));
    expect(candidates.map((c) => c.join())).toContain(left.join());
  });

  it("would leave a mix of versions without the lock (control for the test above)", async () => {
    const store = latent(new InMemoryVectorStore(), { lock: false });
    const left = await raceIngests(store, DIMS, [1, 2]);
    const candidates = await Promise.all([1, 2].map((v) => expectedIds(versionText(v), DIMS)));
    expect(candidates.map((c) => c.join())).not.toContain(left.join());
    expect(left.length).toBe(candidates[0]!.length + candidates[1]!.length);
  });

  it("does not block ingests of different documents on each other", async () => {
    const store = latent(new InMemoryVectorStore(), { lock: true });
    const service = new RagService({ embedder: slowEmbedder(DIMS), store, generator: new ExtractiveGenerator() });
    const results = await Promise.all(["a", "b", "c"].map((id) => service.ingest({ id, text: `Note for ${id}.` })));
    expect(results.map((r) => r.added)).toEqual([1, 1, 1]);
    expect(await store.count()).toBe(3);
  });
});

describe("KeyedMutex", () => {
  it("serialises per key in call order and survives rejections", async () => {
    const mutex = new KeyedMutex();
    const order: string[] = [];
    const task = (name: string, fail = false) =>
      mutex.run("k", async () => {
        order.push(`start ${name}`);
        await new Promise((r) => setTimeout(r, 5));
        order.push(`end ${name}`);
        if (fail) throw new Error(name);
      });
    const results = await Promise.allSettled([task("1"), task("2", true), task("3")]);
    expect(order).toEqual(["start 1", "end 1", "start 2", "end 2", "start 3", "end 3"]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected", "fulfilled"]);
  });
});
