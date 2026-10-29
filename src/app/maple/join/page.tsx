import JoinPage from "./JoinPage";

export const dynamic = "force-dynamic";

/** A link nobody has opened cannot identify its sender. */
export default function Page() {
  return <JoinPage askWho="whoever sent it" />;
}
