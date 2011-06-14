class Drawing
  def initialize(drawing)
    @drawing = drawing
  end
  
  def save
    id = @drawing.delete(:id)
    REDIS.set Drawing.key(id), @drawing.to_json
    REDIS.lpush "drawings", id
  end
  
  def self.find(id)
    JSON.parse(REDIS.get(key(id)))
  end
  
  def self.destroy(id)
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
  
  private
  
  def self.key(id)
    "drawing:#{id}"
  end
end