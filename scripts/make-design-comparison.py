import argparse
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_IMPLEMENTATION = ROOT / "artifacts" / "design-qa" / "staff-initial-1488x1058.png"
DEFAULT_OUTPUT = ROOT / "artifacts" / "design-qa" / "staff-source-vs-implementation.png"


def load_font(size: int):
    for candidate in (
        Path(r"C:\Windows\Fonts\tahomabd.ttf"),
        Path(r"C:\Windows\Fonts\arialbd.ttf"),
    ):
        if candidate.exists():
            return ImageFont.truetype(str(candidate), size=size)
    return ImageFont.load_default()


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Place an approved visual source beside the captured Found Roll staff implementation."
    )
    parser.add_argument("source", type=Path, help="Path to the approved source image.")
    parser.add_argument("--implementation", type=Path, default=DEFAULT_IMPLEMENTATION)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    args = parser.parse_args()

    source = Image.open(args.source).convert("RGB")
    implementation = Image.open(args.implementation).convert("RGB")
    target_height = 1058

    if source.height != target_height:
        source = source.resize(
            (round(source.width * target_height / source.height), target_height),
            Image.Resampling.LANCZOS,
        )
    if implementation.height != target_height:
        implementation = implementation.resize(
            (round(implementation.width * target_height / implementation.height), target_height),
            Image.Resampling.LANCZOS,
        )

    gutter = 18
    label_height = 48
    canvas = Image.new(
        "RGB",
        (source.width + implementation.width + gutter * 3, target_height + label_height + gutter * 2),
        "#292d31",
    )
    draw = ImageDraw.Draw(canvas)
    font = load_font(18)

    source_x = gutter
    implementation_x = source_x + source.width + gutter
    image_y = label_height + gutter

    draw.text((source_x, 17), "SELECTED SOURCE", fill="#ffffff", font=font)
    draw.text((implementation_x, 17), "RUNNABLE IMPLEMENTATION", fill="#ffffff", font=font)
    canvas.paste(source, (source_x, image_y))
    canvas.paste(implementation, (implementation_x, image_y))

    args.output.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(args.output, optimize=True)
    print(args.output)


if __name__ == "__main__":
    main()
