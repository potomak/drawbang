include Magick

drawings = Drawing.all :per_page => 999999
puts "#{drawings.size} drawings found"

drawings.each do |drawing|
  puts "opening #{drawing['url']}"
  open(drawing['url']) do |stringio|
    image = Image.from_blob(stringio.string)[0]
    puts "image created"
    
    thumb = image.resize(Drawing::THUMB_WIDTH, Drawing::THUMB_HEIGHT, BoxFilter)
    puts "thumb created"
    
    Drawing.save_image(
      "#{drawing[:id]}_64.png",
      nil,
      thumb.to_blob)
    puts "thumb saved"
  end
end