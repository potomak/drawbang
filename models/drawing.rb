require 'RMagick'

class Drawing
  include Magick
  
  WIDTH = 16
  HEIGHT = 16
  EXPORT_WIDTH = 320
  EXPORT_HEIGHT = 320
  THUMB_WIDTH = 64
  THUMB_HEIGHT = 64
  FPS = 5
  
  def initialize(drawing)
    @drawing = drawing
  end
  
  def save
    id = @drawing.delete(:id)
    image_data = @drawing.delete(:image_data)
    image = @drawing.delete(:image)
    format = image['frames'] ? "GIF" : "PNG"
    request_host = @drawing.delete(:request_host)
    image_object = Drawing.process_image(image)
    
    # save image
    image_url = Drawing.save_image(id, request_host, image_object.to_blob {|i| i.format = format})
    @drawing.merge!(:url => image_url)
    
    # save thumbnail
    if "GIF" == format
      image_list = ImageList.new
      image_object.each do |frame|
        image_list << frame.resize(THUMB_WIDTH, THUMB_HEIGHT, BoxFilter)
      end
      Drawing.save_image(
        "#{id}_64.gif",
        request_host,
        image_list.to_blob {|i| i.format = format})
    else
      Drawing.save_image(
        "#{id}_64.#{format.downcase}",
        request_host,
        image_object.resize(THUMB_WIDTH, THUMB_HEIGHT, BoxFilter).to_blob {|i| i.format = format})
    end
    
    REDIS.set Drawing.key(id), @drawing.to_json
    REDIS.lpush "drawings", id
    
    @drawing
  end
  
  def self.find(id)
    value = REDIS.get(key(id))
    JSON.parse(value) unless value.nil?
  end
  
  def self.destroy(id)
    if is_production?
      init_aws
      AWS::S3::S3Object.delete id, S3_BUCKET
    else
      File.delete(File.join(DRAWINGS_PATH, id))
    end
    
    REDIS.del(key(id))
    REDIS.lrem("drawings", 0, id)
  end
  
  def self.all(opts)
    page = opts[:page] || 0
    per_page = opts[:per_page] || 10
    host = opts[:host] || "localhost:4567"
    
    start_index = page*per_page
    end_index = start_index + per_page-1
    
    REDIS.lrange("drawings", start_index, end_index).map do |id|
      JSON.parse(REDIS.get(key(id))).merge(:id => id, :share_url => "http://#{host}/drawings/#{id}")
    end
  end
  
  def self.key(id)
    "drawing:#{id}"
  end
  
  def self.is_production?
    :production == settings.environment
  end
  
  def self.init_aws
    AWS::S3::Base.establish_connection!(
      :access_key_id     => ENV['S3_KEY'],
      :secret_access_key => ENV['S3_SECRET']
    )
  end
  
  def self.process_image(image)
    if image['frames']
      anim = ImageList.new
      
      image['frames'].each do |frame|
        frame_image = Image.constitute(WIDTH, HEIGHT, "RGBA", build_pixels(frame))
        frame_image.dispose = PreviousDispose
        anim << frame_image.resize(EXPORT_WIDTH, EXPORT_HEIGHT, BoxFilter)
      end
      
      anim.delay = (1/FPS.to_f)*100
      anim
    elsif image['frame']
      Image.constitute(WIDTH, HEIGHT, "RGBA", build_pixels(image['frame'])).resize(EXPORT_WIDTH, EXPORT_HEIGHT, BoxFilter)
    else
      raise "Error: unknown format (image.inspect: #{image.inspect})"
    end
  end
  
  def self.build_pixels(frame)
    pixels = []
    
    frame.each_index do |i|
      frame[i].each_index do |j|
        a, r, g, b = parse_color(frame[i][j])
        
        pixels[(j*WIDTH*4)+(i*4)] = r*256
        pixels[(j*WIDTH*4)+(i*4)+1] = g*256
        pixels[(j*WIDTH*4)+(i*4)+2] = b*256
        pixels[(j*WIDTH*4)+(i*4)+3] = a
      end
    end
    
    pixels
  end
  
  def self.parse_color(string)
    if "rgba(0, 0, 0, 0)" == string
      return 0, 0, 0, 0
    else
      color = /#([a-fA-F0-9]{2})([a-fA-F0-9]{2})([a-fA-F0-9]{2})/
      component = /^[a-fA-F0-9]{2}$/
      rgb = string.match(color).select { |c| c.match(component) }.map { |c| c.hex }
      return QuantumRange, *rgb
    end
  end
  
  def self.save_image(filename, request_host, content)
    if is_production?
      init_aws
      
      # save image
      AWS::S3::S3Object.store(
        filename,
        content,
        S3_BUCKET,
        :access => :public_read)
      
      AWS::S3::S3Object.find(filename, S3_BUCKET).url(:authenticated => false)
    else
      # save image
      File.open(File.join(DRAWINGS_PATH, filename), "w") do |file|
        file << content
      end
      
      "http://#{request_host}/images/drawings/#{filename}"
    end
  end
end