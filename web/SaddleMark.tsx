// Signal & Ledger: símbolo modular de sela que conecta storage e compute.
import { assetpath } from "@/paths";

type SaddleMarkProps = {
  className?: string;
  label?: string;
};

export function SaddleMark({ className = "h-9 w-9", label = "Saddle" }: SaddleMarkProps) {
  return (
    <img
      className={className}
      src={assetpath("assets/saddle-mark.webp")}
      alt={label}
      width="40"
      height="40"
    />
  );
}

export default SaddleMark;
