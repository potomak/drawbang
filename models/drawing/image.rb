module Image
  WIDTH  = 16
  HEIGHT = 16
  FPS    = 5
  TYPES  = {
    :export => {
      :width  => 320,
      :height => 320
    },
    :thumb => {
      :width  => 64,
      :height => 64
    },
    :favicon => {
      :width  => 16,
      :height => 16
    }
  }
  
  def self.included(base) # :nodoc:
    base.extend ClassMethods
  end
  
  module ClassMethods
    # process_image
    def process_image(raw_image)
      if raw_image['frames']
        anim = Magick::ImageList.new

        raw_image['frames'].each do |frame|
          frame_image = constitute_image(frame)
          frame_image.dispose = Magick::PreviousDispose
          anim << resize_image(frame_image)
        end

        anim.delay = (1/FPS.to_f)*100
        anim
      elsif raw_image['frame']
        resize_image(constitute_image(raw_image['frame']))
      else
        raise "Error: unknown format (raw_image.inspect: #{raw_image.inspect})"
      end
    end
    
    # process_thumbnail
    def process_thumbnail(image_object)
      if image_object.is_a? Magick::ImageList
        image_list = Magick::ImageList.new
        image_object.each do |frame|
          image_list << resize_image(frame, :thumb)
        end
        image_list
      else
        resize_image(image_object, :thumb)
      end
    end
    
    # constitute_image
    def constitute_image(frame)
      Magick::Image.constitute(WIDTH, HEIGHT, "RGBA", build_pixels(frame))
    end
    
    # resize_image
    def resize_image(image, type = :export)
      image.resize(TYPES[type][:width], TYPES[type][:height], Magick::BoxFilter)
    end
    
    # build_pixels
    def build_pixels(frame)
      pixels = []

      frame.each_index do |i|
        frame[i].each_index do |j|
          parse_color(frame[i][j]).each_with_index do |c, k|
            pixels[(j*WIDTH*4)+(i*4)+k] = c
          end
        end
      end

      pixels
    end
    
    # parse_color
    def parse_color(string)
      if "rgba(0, 0, 0, 0)" == string
        return [0, 0, 0, 0]
      else
        color = /#([a-fA-F0-9]{2})([a-fA-F0-9]{2})([a-fA-F0-9]{2})/
        component = /^[a-fA-F0-9]{2}$/
        rgb = string.match(color).select { |c| c.match(component) }.map { |c| c.hex*256 }
        return rgb + [Magick::QuantumRange]
      end
    end

    # parse pixel color
    def parse_pixel_color(pixel)
      if 0 != pixel.opacity
        "rgba(0, 0, 0, 0)"
      else
        # returns color name corresponding the the pixel values
        # format: #rrrrggggbbbbaaaa
        color = pixel.to_color(Magick::AllCompliance, false, Magick::QuantumDepth, true)

        component = /([a-fA-F0-9]{2})[a-fA-F0-9]{2}/
        color_pattern = /##{component}#{component}#{component}/
        "##{color.match(color_pattern).select {|c| 2 == c.size}.join}"
      end
    end
    
    # downloads thumb image, parses it and returns raw data
    #
    # KNOWN BUG: calling this function on PNG images where there's
    #            only black color returns an array full of black.
    def image_raw_data(thumb_url)
      raw_data = []
      open(thumb_url) do |f|
        image_list = Magick::Image.from_blob(f.read)
        image_list.each do |image|
          raw_data << (0..15).map do |i|
            (0..15).map do |j|
              # thumbs size 64x64, image size 16x16, zoom 4x 
              parse_pixel_color(image.pixel_color(i*4, j*4))
            end
          end 
        end

        raw_data
      end
    end
  end
end