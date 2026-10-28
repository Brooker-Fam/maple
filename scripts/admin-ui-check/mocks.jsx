// Framework/provider boundaries only; the admin UI and requests remain real.
export default function Link({ href, children, ...props }) {
  return <a href={href} {...props}>{children}</a>;
}

export const useMaple = () => ({});
export const useNow = () => new Date("2026-10-28T16:00:00.000Z");
