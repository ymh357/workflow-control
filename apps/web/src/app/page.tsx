"use client";

export default function Home() {
  return (
    <main style={{ padding: "2rem", fontFamily: "system-ui, sans-serif", maxWidth: "640px", margin: "0 auto" }}>
      <h1 style={{ marginBottom: "1rem" }}>workflow-control (kernel-next)</h1>
      <p style={{ lineHeight: 1.6 }}>
        This server runs kernel-next pipelines. Start a task via the MCP tool{" "}
        <code>run_pipeline</code> or{" "}
        <code>POST /api/kernel/tasks/run</code>.
      </p>
      <p style={{ lineHeight: 1.6 }}>
        Live task views are at{" "}
        <code>/kernel-next/&lt;taskId&gt;</code>.
      </p>
      <p style={{ lineHeight: 1.6, fontSize: "0.9rem", color: "#666" }}>
        See{" "}
        <a href="https://github.com/ymh357/workflow-control">docs</a>{" "}
        for more.
      </p>
    </main>
  );
}
