EGA_PALETTE.each_with_index do |c, i|
  hsl = Color::RGB.from_html(c).to_hsl
  hsl.l *= 0.8
  puts "#colors .color #color_#{i+1}::before { background-color: #{hsl.html}; }"
  hsl.l *= 0.7
  puts "#colors .color #color_#{i+1}::after { background-color: #{hsl.html}; }"
end