import type { ButtonHTMLAttributes, LabelHTMLAttributes } from "react";

const base = "tap-scale rounded-lg px-4 py-2.5 text-sm font-semibold transition disabled:opacity-50";
const variants = {
  primary: "bg-gradient-to-r from-primary-purple to-primary-pink text-white shadow-md shadow-primary-pink/20 hover:opacity-90",
  secondary: "border border-border bg-surface text-foreground hover:border-primary-pink",
  ghost: "text-neutral-500 hover:text-foreground",
};

export function Button({
  variant = "primary",
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: keyof typeof variants }) {
  return <button className={`${base} ${variants[variant]} ${className}`} {...props} />;
}

export function ButtonLabel({
  variant = "primary",
  className = "",
  ...props
}: LabelHTMLAttributes<HTMLLabelElement> & { variant?: keyof typeof variants }) {
  return <label className={`${base} inline-block cursor-pointer text-center ${variants[variant]} ${className}`} {...props} />;
}

export function Card({ className = "", ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={`rounded-xl border border-border bg-surface ${className}`} {...props} />;
}

export function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={`w-full rounded-lg border border-border bg-surface px-3 py-2 text-foreground focus:border-primary-pink focus:outline-none ${props.className ?? ""}`}
    />
  );
}
