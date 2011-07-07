class Drawing
  def initialize(drawing)
    @drawing = drawing
  end
  
  def save
    id = @drawing.delete(:id)
    image_data = @drawing.delete(:image_data)
    request_host = @drawing.delete(:request_host)
    
    if Drawing.is_production?
      Drawing.init_aws
      
      AWS::S3::S3Object.store(
        id,
        Drawing.decode_png(image_data),
        S3_BUCKET,
        :access => :public_read)
      
      @drawing.merge!(:url => AWS::S3::S3Object.find(id, S3_BUCKET).url(:authenticated => false))
    else
      File.open(File.join(DRAWINGS_PATH, id), "w") do |file|
        file << Drawing.decode_png(image_data)
      end
      
      @drawing.merge!(:url => "http://#{request_host}/images/drawings/#{id}")
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
  
  def self.decode_png(string)
    Base64.decode64(string.gsub(/data:image\/png;base64/, '')) unless string.nil?
  end
end