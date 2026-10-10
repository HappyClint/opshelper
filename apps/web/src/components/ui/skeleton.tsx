interface SkeletonProps {
  width?: number | string;
  height?: number | string;
  variant?: "text" | "rect";
  className?: string;
}

export function Skeleton({
  width,
  height,
  variant = "rect",
  className,
}: SkeletonProps) {
  const style: React.CSSProperties = {};
  if (width !== undefined) style.width = typeof width === "number" ? `${width}px` : width;
  if (height !== undefined) style.height = typeof height === "number" ? `${height}px` : height;
  const classes = ["skeleton", variant === "text" ? "skeleton-text" : "skeleton-rect"];
  if (className) classes.push(className);
  return <span aria-hidden="true" className={classes.join(" ")} style={style} />;
}
