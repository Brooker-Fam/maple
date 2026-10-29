import { useState } from "react";
import { createRoot } from "react-dom/client";
import { MapleProvider, useMaple } from "../../src/components/maple/useMaple";
import MomentSheet from "../../src/components/maple/sheets/MomentSheet";

function QueuedMoment() {
  const maple = useMaple();
  const [entry, setEntry] = useState(null);
  window.__queuedMoment = { refresh: maple.refresh, state: maple.state, pending: maple.pending };
  if (!maple.state) return <p>Loading</p>;
  return <><button onClick={async () => setEntry(await maple.log({ kind: "moment", data: { title: "Queued synthetic moment", photos: [] }, note: "Synthetic queued memory" }))}>Create queued moment</button>
    <button onClick={async () => {
      await maple.log({ kind: "moment", data: { title: "First queued moment", photos: [] } });
      setEntry(await maple.log({ kind: "moment", data: { title: "Second queued moment", photos: [] } }));
    }}>Create two queued moments</button>
    <MomentSheet open={!!entry} entry={entry ?? undefined} onClose={() => setEntry(null)} />
  </>;
}
createRoot(document.getElementById("root")).render(<MapleProvider><QueuedMoment /></MapleProvider>);
