import sys
from PIL import Image

source, rows, cols, *outputs = sys.argv[1:]
rows, cols = int(rows), int(cols)
if len(outputs) != rows * cols:
    raise ValueError('Output count does not match grid')

with Image.open(source) as image:
    width, height = image.size
    for row in range(rows):
        for col in range(cols):
            box = (
                col * width // cols,
                row * height // rows,
                (col + 1) * width // cols,
                (row + 1) * height // rows,
            )
            image.crop(box).save(outputs[row * cols + col], format='PNG')
