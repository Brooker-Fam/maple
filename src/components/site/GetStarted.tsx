import Link from "next/link";

export const SIGNUP_PATH = "/signup";
export const SIGN_IN_PATH = "/maple";

export default function GetStarted({ size = "large", className = "" }: { size?: "small" | "large"; className?: string }) {
  return (
    <Link
      href={SIGNUP_PATH}
      prefetch={false}
      className={`site-button ${size === "small" ? "site-button-sm" : ""} inline-flex items-center justify-center whitespace-nowrap ${className}`}
    >
      Get started
    </Link>
  );
}
